const {
  MatrixAppServiceBridge: {
    Cli, AppServiceRegistration, EventBridgeStore, StoredEvent
  },
  Puppet,
  MatrixPuppetBridgeBase,
  utils: { download }
} = require("matrix-puppet-bridge");
const SignalClient = require('signal-client');
const config = require('./config.json');
const path = require('path');
const puppet = new Puppet(path.join(__dirname, './config.json' ));
const debug = require('debug')('matrix-puppet:signal');
let fs = require('fs');
let Promise = require('bluebird');

const {default: PQueue} = require('p-queue');
const messageQueue = new PQueue({concurrency: 1});

class App extends MatrixPuppetBridgeBase {
  getServicePrefix() {
    return "signal";
  }
  getServiceName() {
    return "Signal";
  }
  initThirdPartyClient() {
    this.client = new SignalClient("matrix");
    this.myNumber = config.phoneNumber.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    this.client.on('message', (ev) => {
      const { source, message, timestamp } = ev.data;
      let room = source;
      let members = [source];
      if ( message.group != null ) {
        //Signal sends new groups as a message with a group name set
        //Messages in groups have a group but without name attached
        if(message.group.name != null) {
          this.handleSignalGroup(message.group);
          return;
        }
        room = window.btoa(message.group.id);
        members = message.group.membersE164;
      }
      messageQueue.add(() => {
        return this.handleSignalMessage({
        roomId: room,
        senderId: source,
        }, message, timestamp, members);
      })
    });

    this.client.on('sent', (ev) => {
      const { destination, message, timestamp } = ev.data;
      let room = destination;
      let members = [destination];
      if ( message.group != null ) {
        if(message.group.name != null) {
          this.handleSignalGroup(message.group);
          return;
        }
        room = window.btoa(message.group.id);
        members = message.group.membersE164;
      }
      messageQueue.add(() => {
        return this.handleSignalMessage({
          roomId: room,
          senderId: undefined,
          senderName: destination,
        }, message, timestamp, members);
      })
    });

    this.client.on('read', (ev) => {
      const { timestamp, reader } = ev.read;
      console.log("read event", timestamp, reader);
      this.handleSignalReadReceipt(timestamp, reader);
    });

    this.groups = new Map(); // abstract storage for groups
    
    // triggered when we run syncGroups
    this.client.on('group', (ev) => {
      if(!ev.groupDetails.active) {
        return;
      }
      this.handleSignalGroup(ev.groupDetails);
    });

    this.contacts = new Map();
    
    this.client.on('contact', (ev) => {
      console.log('contact received', ev.contactDetails);
      let contact = {};
      contact.userId = ev.contactDetails.number;
      contact.senderName = ev.contactDetails.name;
      contact.name = ev.contactDetails.name;
      if (contact.name == null) {
        //If the unnamed sender allows us to use his profile name we will use this
        this.client.getProfileNameForPhoneNumber(contact.userId).then(profileName => {
          contact.name = profileName;
        });
      }

      if(ev.contactDetails.avatar) {
        let dataBuffer = Buffer.from(ev.contactDetails.avatar.data);
        contact.avatar = {type: 'image/jpeg', buffer: dataBuffer};
      }
      this.contacts.set(ev.contactDetails.number, contact);
      this.joinThirdPartyUsersToStatusRoom([contact]);
    });

    this.client.on('typing', (ev)=>{
      let timestamp = ev.typing.timestamp;
      let sender = ev.sender;
      let status = ev.typing.started;
      console.log('typing event', sender, timestamp, status);
      let group = null;
      if(ev.typing.groupId) {
        group = window.btoa(ev.typing.groupId);
      }
      this.handleTypingEvent(sender,status,group);
    });

    setTimeout(this.client.syncContacts, 5000); // request for sync contacts
    setTimeout(this.client.syncGroups, 10000); // request for sync groups

    return this.client.start();
  }
  
  async handleSignalGroup(groupDetails) {
    console.log("Group received ", groupDetails);
    let id = window.btoa(groupDetails.id);
    if (groupDetails.name == "") {
      groupDetails.name = "Unnamed Group";
    }
    let group = { name: groupDetails.name };
    if(groupDetails.avatar) {
      //If desktop knows the group it sends an array buffer
      if (groupDetails.avatar.data) {
        group.avatar = {type: 'image/jpeg', buffer: groupDetails.avatar.data};
      }
      //Otherwise we have to download it first
      else {
        const avData = await this.client.downloadAttachment(groupDetails.avatar);
        group.avatar = {type: 'image/jpeg', buffer: avData.data};
      }
    }
      
    this.groups.set(id, group);
    const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(id);
    const otherPeople = groupDetails.membersE164.filter(phoneNumber => !phoneNumber.match(this.myNumber));

    for (let i = 0; i < otherPeople.length; ++i) {
      let ghost = await this.getIntentFromThirdPartySenderId(otherPeople[i]);
      const roomsGhost = await ghost.getClient().getJoinedRooms();
      const hasGhostJoined = roomsGhost.joined_rooms.includes(matrixRoomId);
      if (!hasGhostJoined) {
        console.log("Letting member join room", otherPeople[i]);
        try {
          await this.puppet.getClient().invite(matrixRoomId, ghost.client.credentials.userId);
          await ghost._ensureJoined(matrixRoomId);
        } catch(err) {
          console.log("failed to join ghost: ", otherPeople[i], matrixRoomId, err);
        }
      }
    }
  }
  
  async handleSignalMessage(payload, message, timeStamp, members = []) {
    this.handleTypingEvent(payload.roomId, false, payload.roomId);
    if ( message.body ) {
      payload.text = message.body
    }
    //Undefined text means file will not get through, so we just set it to empty string
    else {
      payload.text = "";
    }
    
    if (!payload.senderName) {  //Make sure senders have a name so they show up.
      if (payload.senderId) {
        const remoteUser = await this.getOrInitRemoteUserStoreDataFromThirdPartyUserId(payload.senderId);
        payload.senderName = remoteUser.get('senderName');
        if (!payload.senderName) {
          //If the unnamed sender allows us to use his profile name we will use this after everything failed
          const profileName = await this.client.getProfileNameForPhoneNumber(payload.senderId);
          payload.senderName = profileName;
        }
      }
      if (!payload.senderName) {
        payload.senderName = "Unnamed Person";
      }
    }
    if (message.sticker != null) {  //TODO: correctly handle sticker in both directions
      payload.text = "Bridge Message: Stickers are not supported right now";
    }
    const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(payload.roomId);
    let messageForEvent;
    if ( message.attachments.length === 0 ) {
      if(payload.text == null) {
        return;
      }
      const matrixEventId = await this.handleThirdPartyRoomMessage(payload);
      for ( let i = 0; i < members.length; i++ ) {
//         //Signal uses timestamp as message id, and looks up recipients by timestamp before finding the one for the receipt.
//         //Therefore we add it to the event store with roomId timestamp and eventId user, so we can find event later
        messageForEvent = new StoredEvent(matrixRoomId, matrixEventId, timeStamp, members[i]);
        this.bridge.getEventStore().upsertEvent(messageForEvent);
      }
    } else {
      let data;
      for ( let i = 0; i < message.attachments.length; i++ ) {
        let att = message.attachments[i];
        data = await this.client.downloadAttachment(att);
        payload.buffer = new Buffer.from(data.data);
        payload.mimetype = data.contentType;
        const matrixEventId = await this.handleThirdPartyRoomMessageWithAttachment(payload);
        for ( let i = 0; i < members.length; i++ ) {
          messageForEvent = new StoredEvent(matrixRoomId, matrixEventId, timeStamp, members[i]);
          this.bridge.getEventStore().upsertEvent(messageForEvent);
        }
      }
    }
    return true;
  }
  async handleTypingEvent(sender,status,group) {
    try {
      let id = sender;
      if (group) {
        id = group;
      }
      const ghostIntent = await this.getIntentFromThirdPartySenderId(sender);
      const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(id);
      return ghostIntent.sendTyping(matrixRoomId, status, 60000);
    } catch (err) {
      debug('could not send typing event', err.message);
    }
  }

  async handleSignalReadReceipt(timeStamp, reader) {
    try {
      //Get event and roomId from the eventstore
      const eventEntry = await this.bridge.getEventStore().getEntryByRemoteId(timeStamp, reader);
      if (eventEntry != undefined && eventEntry != null) {
        const matrixRoomId = eventEntry.getMatrixRoomId();
        const matrixEventId = eventEntry.getMatrixEventId();
        const ghostIntent = await this.getIntentFromThirdPartySenderId(reader);
        ghostIntent.sendReadReceipt (matrixRoomId, matrixEventId);
      }
      else {
        debug('no event found for', timeStamp, reader);
      }
    } catch (err) {
      debug('could not send read event', err.message);
    }
  }

  getThirdPartyRoomDataById(id) {
    let name = "";
    let topic = "Signal Direct Message";
    let avatar;
    if ( this.contacts.has(id) ) {
      name = this.contacts.get(id).name;
      avatar = this.contacts.get(id).avatar;
    }
    if ( this.groups.has(id) ) {
      name = this.groups.get(id).name;
      topic = "Signal Group Message";
      avatar = this.groups.get(id).avatar;
    }
    return Promise.resolve({name, topic, avatar, is_direct: false});
  }
  getThirdPartyUserDataById(id) {
    if(this.contacts.has(id)) {
      let contact = this.contacts.get(id);
      contact.is_direct = true;
      return contact;
    } else {
      return {senderName: id};
    }
  }
  async sendReadReceiptAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId) {
    let timeStamp = await new Date().getTime();
    if (this.groups.has(thirdPartyRoomId)) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
    }
    
    console.log("sending read receipts for " + thirdPartyRoomId);

    // mark messages as read in your signal clients
    await this.client.syncReadReceipts(thirdPartyRoomId, this.groups.has(thirdPartyRoomId), timeStamp, config.sendReadReceipts);

    return true;
  }

  async sendTypingEventAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, status) {
    if (this.groups.has(thirdPartyRoomId)) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
    }
    await this.client.sendTypingMessage(thirdPartyRoomId, this.groups.has(thirdPartyRoomId), status, config.sendTypingEvents);
  }

  sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    return this.sendFileMessageAsPuppetToThirdPartyRoomWithId(id, data);
  }

  sendFileMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, data) {
    data.text = "";
    if (this.groups.has(thirdPartyRoomId)) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
    }
    return download.getTempfile(data.url, { tagFilename: true }).then(({path}) => {
      let file = fs.readFileSync(path);
      let bufferArray = new Uint8Array(file).buffer;
      //We need to set a mimetype otherwise signal crashes
      if (!data.mimetype) {
        data.mimetype = "";
      }
      let attachment = {
        data: bufferArray,
        size: file.byteLength,
        contentType: data.mimetype,
        fileName: data.filename,
        path: path,
      };
      return this.client.sendMessage(thirdPartyRoomId, this.groups.has(thirdPartyRoomId), data.text, [attachment]).then(result => {
        let {timeStamp, recipients} = result;
        let message;
        for ( let i = 0; i < recipients.length; i++ ) {
          message = new StoredEvent(data.room_id, data.event_id, timeStamp, recipients[i], {ev: data});
          this.bridge.getEventStore().upsertEvent(message);
        }
      });
    });
  }

  sendMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, text, event) {
    if (this.groups.has(thirdPartyRoomId)) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
    }
    return this.client.sendMessage(thirdPartyRoomId, this.groups.has(thirdPartyRoomId), text).then(result => {
      let {timeStamp, recipients} = result;
      let message;
      for ( let i = 0; i < recipients.length; i++ ) {
        message = new StoredEvent(event.room_id, event.event_id, timeStamp, recipients[i]);
        this.bridge.getEventStore().upsertEvent(message);
      }
    });
  }
}

new Cli({
  port: config.port,
  registrationPath: config.registrationPath,
  generateRegistration: function(reg, callback) {
    puppet.associate().then(()=>{
      reg.setId(AppServiceRegistration.generateToken());
      reg.setHomeserverToken(AppServiceRegistration.generateToken());
      reg.setAppServiceToken(AppServiceRegistration.generateToken());
      reg.setSenderLocalpart("signalbot");
      reg.addRegexPattern("users", "@signal_.*", true);
      reg.addRegexPattern("aliases", "#signal_.*", true);
      callback(reg);
    }).catch(err=>{
      console.error(err.message);
      process.exit(-1);
    });
  },
  run: function(port) {
    const app = new App(config, puppet);
    console.log('starting matrix client');
    return puppet.startClient().then(()=>{
      console.log('starting signal client');
      return app.initThirdPartyClient();
    }).then(()=>{
      return app.bridge.run(port, config);
    }).then(()=>{
      console.log('Matrix-side listening on port %s', port);
    }).catch(err=>{
      console.error(err.message);
      process.exit(-1);
    });
  }
}).run();
