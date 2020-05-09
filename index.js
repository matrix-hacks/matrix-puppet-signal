const {
  MatrixAppServiceBridge: {
    Cli, AppServiceRegistration, EventBridgeStore, StoredEvent, RemoteUser, UserBridgeStore
  },
  Puppet,
  MatrixPuppetBridgeBase,
  utils: { download, sleep }
} = require("matrix-puppet-bridge");
const SignalClient = require('signal-client');
const config = require('./config.json');
const path = require('path');
const puppet = new Puppet(path.join(__dirname, './config.json' ));
const debug = require('debug')('matrix-puppet:signal');
let fs = require('fs');
let Promise = require('bluebird');

const {default: PQueue} = require('p-queue');
//We start the queue after client is ready
//It makes sure all events from signal are handled in the correct order
const signalQueue = new PQueue({concurrency: 1, autoStart: false});

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
          //We add it to the queue to make sure rooms get created before another message is being sent
          signalQueue.add(() => {
            return this.handleSignalGroup(message.group);
          });
          return;
        }
        room = window.btoa(message.group.id);
      }
      signalQueue.add(() => {
        return this.handleSignalMessage({
        roomId: room,
        senderId: source,
        }, message, timestamp, members, false);
      })
    });

    this.client.on('sent', (ev) => {
      const { destination, message, timestamp } = ev.data;
      let room = destination;
      let members = [destination];
      if ( message.group != null ) {
        if(message.group.name != null) {
          signalQueue.add(() => {
            return this.handleSignalGroup(message.group);
          });
          return;
        }
        room = window.btoa(message.group.id);
//We add all members to be able to correctly use read receipts
        const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
        if ( room && room.isGroup == true) {
          members = room.members;
        }
      }
      signalQueue.add(() => {
        return this.handleSignalMessage({
          roomId: room,
          //Flag for base to know it is sent from us
          senderId: undefined,
          senderName: this.myNumber.substring(this.myNumber.lastIndexOf("\\") +1),
        }, message, timestamp, members, true);
      })
    });

    // triggered when we run syncGroups
    this.client.on('group', (ev) => {
      if(!ev.groupDetails.active) {
        return;
      }
      signalQueue.add(() => {
        return this.handleSignalGroup(ev.groupDetails);
      });
    });
    
    this.client.on('contact', (ev) => {
      //Makes startup slower but ensures all contacts are synced as we have no race in joining status room
      signalQueue.add(async () => {
        return this.handleSignalContact(ev.contactDetails);
      });
    });

    this.client.on('read', (ev) => {
      const { timestamp, reader } = ev.read;
      console.log("read event", timestamp, reader);
      signalQueue.add(() => {
        return this.handleSignalReadReceipt(timestamp, reader);
      });
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
      signalQueue.add(() => {
        this.handleTypingEvent(sender,status,group);
      });
    });    
    
    
    this.client.on('client_ready', () => {
      //Request sync and start handling of signal stuff
      this.client.syncContacts();
      this.client.syncGroups();
      signalQueue.start();
    });

    return this.client.start();
  }
  
  async handleSignalContact(contactDetails) {
    console.log('contact received', contactDetails);
    let contact = {};
    contact.userId = contactDetails.number;
    if (contactDetails.name != null) {
      contact.senderName = contactDetails.name;
      contact.name = contactDetails.name;
    }
    else {
      //If the unnamed sender allows us to use his profile name we will use this
      contact.name = await this.client.getProfileNameForId(contact.userId);
      contact.senderName = await this.client.getProfileNameForId(contact.userId);
    }
    if (!contact.name) {
      contact.name = "Unnamed Person";
      contact.senderName = "Unnamed Person";
    }

    if(contactDetails.avatar) {
      let dataBuffer = Buffer.from(contactDetails.avatar.data);
      contact.avatar = {type: 'image/jpeg', buffer: dataBuffer};
    }
    
    const userStore = this.bridge.getUserStore();
    let rUser = await userStore.getRemoteUser(contact.userId);
    if ( rUser ) {
        rUser.set('name', contact.name);
        rUser.set('avatar', contact.avatar);
        await userStore.setRemoteUser(rUser);
    }
    else {
      //To differentiate between user and groups
      contact.isGroup = false;
      await userStore.setRemoteUser(new RemoteUser(contact.userId, contact));
    }
    
    let retry = 3;
    let lastError;
    let timeOut = 100;
    while (retry--) {
      try {
        return await this.joinThirdPartyUsersToStatusRoom([contact]);
      } catch(err) {
        lastError = err;
      }
      if (lastError.errcode == 'M_LIMIT_EXCEEDED' && lastError.data.retry_after_ms) {
        console.log("Matrix forces us to wait for ", lastError.data.retry_after_ms);
        timeOut = lastError.data.retry_after_ms;
      }            
      await sleep(timeOut);
    }
    console.log("Could not join user to status room, error:", lastError);
    return;
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
    const otherPeople = groupDetails.membersE164.filter(phoneNumber => !phoneNumber.match(this.myNumber));
    group.members = otherPeople;
      
    //We use userStore for groups as rooms need a linked matrix room
    const userStore = this.bridge.getUserStore();
    let rGroup = await userStore.getRemoteUser(id);
    if ( rGroup ) {
      if ( rGroup.get('isGroup') == true) {
        rGroup.set('name', group.name);
        rGroup.set('avatar', group.avatar);
        rGroup.set('members', group.members);
        await userStore.setRemoteUser(rUser);
      }
      else {
        console.error("There seems to be a user with the same id as a new group");
        return;
      }
    }
    else {
      group.isGroup = true;
      await userStore.setRemoteUser(new RemoteUser(id, group));
    }
    
    const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(id);

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
    return true;
  }
  
  async handleSignalMessage(payload, message, timeStamp, members = [], sentMessage = false) {
    this.handleTypingEvent(payload.senderId, false, payload.roomId);
    if ( message.body ) {
      payload.text = message.body
    }
    //Undefined text means file will not get through, so we just set it to empty string
    else {
      payload.text = "";
    }
    //stickers seem to be just glorified pictures
    if (message.sticker != null) {
      message.attachments.push(message.sticker.data);
    }
    if (message.reaction != null) {   
//       We ignore remove events (redactions not implemented)
      if (message.reaction.remove == true) {
        return;
      }
      const reactionEventEntry = await this.bridge.getEventStore().getEntryByRemoteId(message.reaction.targetTimestamp.toNumber(), message.reaction.targetAuthorE164);
      if (reactionEventEntry != null) {
        payload.reaction = {
          roomId: reactionEventEntry.getMatrixRoomId(),
          eventId: reactionEventEntry.getMatrixEventId(),
          emoji: message.reaction.emoji,
        }
      }
      else {
        debug("Did not find event for", message.reaction.targetTimestamp.toNumber(), message.reaction.targetAuthorE164);
        return;
      }
//       reactions sent from us don't have a destination, therefore we need to set it to something (will not be used anyway)
      if (payload.roomId == null) {
        payload.roomId = message.reaction.targetAuthorE164;
      }
    }
    
    //pictures as quotes cannot be handled in matrix so we ignore the quote
    if (message.quote != null && message.attachments.length === 0) {
      
      //Get eventId from the eventstore to look for the quote, always same room so no need for that one
      const quotedEventEntry = await this.bridge.getEventStore().getEntryByRemoteId(message.quote.id, message.quote.author);
      
      if (quotedEventEntry != null) {
        payload.quote = {
          userId: message.quote.author,
          eventId: quotedEventEntry.getMatrixEventId(),
          text: message.quote.text,
        };
        if (message.quote.author == this.myNumber.substring(this.myNumber.lastIndexOf("\\") +1)) {
          payload.quote.userId = undefined;
        }
      }
      else {
        debug("Did not find event for", message.quote.id, message.quote.author);
      }
    }
    
    //TODO: Still needed? Checking when getting contacts anyway
    if (!payload.senderName) {  //Make sure senders have a name so they show up.
      if (payload.senderId) {
        const remoteUser = await this.getOrInitRemoteUserStoreDataFromThirdPartyUserId(payload.senderId);
        payload.senderName = remoteUser.get('senderName');
        if (!payload.senderName) {
          //If the unnamed sender allows us to use his profile name we will use this after everything failed
          const profileName = await this.client.getProfileNameForId(payload.senderId);
          payload.senderName = profileName;
        }
      }
      if (!payload.senderName) {
        payload.senderName = "Unnamed Person";
      }
    }
    
    const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(payload.roomId);
    let matrixEventId;
    if ( message.attachments.length === 0 ) {
      if(payload.text == null) {
        return;
      }
      matrixEventId = await this.handleThirdPartyRoomMessage(payload);
    } else {
      let data;
      for ( let i = 0; i < message.attachments.length; i++ ) {
        let att = message.attachments[i];
        data = await this.client.downloadAttachment(att);
        payload.buffer = new Buffer.from(data.data);
        payload.mimetype = data.contentType;
        matrixEventId = await this.handleThirdPartyRoomMessageWithAttachment(payload);
      }
    }
    this.saveMessageEvents(matrixRoomId, matrixEventId.event_id, timeStamp, members, sentMessage);
    return true;
  }
  async handleTypingEvent(sender,status,group) {
    //We don't need to handle typing events from ourselves
    if (!sender) {
      return;
    }
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
      if (eventEntry != null) {
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

  async getThirdPartyRoomDataById(thirdPartyRoomId) {
    let name = "";
    let topic = "Signal Direct Message";
    let avatar;
    let direct = true;
    const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
    if ( room ) {
      name = room.get('name');
      avatar = room.get('avatar');
      if (room.isGroup == true) {
        topic = "Signal Group Message";
        direct = false;
      }
    }
    return Promise.resolve({name, topic, avatar, is_direct: direct});
  }
  async getThirdPartyUserDataById(thirdPartyRoomId) {
    const contact = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
    if ( contact && contact.isGroup == false ) {
      return contact;
    } else {
      return {senderName: thirdPartyRoomId};
    }
  }
  async sendReadReceiptAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId) {
    let timeStamp = await new Date().getTime();
    let isGroup = false;
    const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
    if ( room && room.isGroup == true) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
      isGroup = true;
    }
    
    console.log("sending read receipts for " + thirdPartyRoomId);

    // mark messages as read in your signal clients
    await this.client.syncReadReceipts(thirdPartyRoomId, isGroup, timeStamp, config.sendReadReceipts);

    return true;
  }

  async sendTypingEventAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, status) {
    let isGroup = false;
    const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
    if ( room && room.isGroup == true) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
      isGroup = true;
    }
    
    await this.client.sendTypingMessage(thirdPartyRoomId, isGroup, status, config.sendTypingEvents);
  }
  
  async sendReactionAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, data) {
    try {
      let isGroup = false;
      const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
      if ( room && room.isGroup == true) {
        thirdPartyRoomId = window.atob(thirdPartyRoomId);
        isGroup = true;
      }
      //Get event and roomId from the eventstore
      const eventEntry = await this.bridge.getEventStore().getEntryByMatrixId(data.room_id, data.content["m.relates_to"].event_id);
      if (eventEntry != null) {
        let target = {
          targetTimestamp: eventEntry.getRemoteRoomId(),
          targetAuthorE164: eventEntry.getRemoteEventId(),
        }
        let reaction = {
          emoji: data.content["m.relates_to"].key,
        }
        return this.client.sendReactionMessage(thirdPartyRoomId, isGroup, reaction, target);
      }
      else {
        debug('no event found for', data.room_id, data.content["m.relates_to"].event_id);
      }  
    } catch (err) {
      debug('could not send reaction', err.message);
    }
  }

  sendImageMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data) {
    return this.sendFileMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data);
  }

  sendAudioAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data) {
    return this.sendFileMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data);
  }

  sendVideoAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data) {
    return this.sendFileMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data);
  }

  sendFileMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, info, data) {
    info.text = "";
    let isGroup = false;
    const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
    if ( room && room.isGroup == true) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
      isGroup = true;
    }
    return download.getTempfile(info.url, { tagFilename: true }).then(({path}) => {
      let file = fs.readFileSync(path);
      let bufferArray = new Uint8Array(file).buffer;
      //We need to set a mimetype otherwise signal crashes
      if (!info.mimetype) {
        info.mimetype = "";
      }
      let finalizedAttachment = {
        info: bufferArray,
        size: file.byteLength,
        contentType: info.mimetype,
        fileName: info.filename,
        path: path,
        data: bufferArray,
      };
      return this.client.sendMessage(thirdPartyRoomId, isGroup, info.text, [finalizedAttachment]).then(result => {
        let {timeStamp, members} = result;
        this.saveMessageEvents(data.room_id, data.event_id, timeStamp, members, true);
      });
    });
  }

//Gives unknown quote if quoted message was image sent from signal with text and we try to quote it
  async sendMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, text, data) {

    let quote = null;
    if (data.content["m.relates_to"] && data.content["m.relates_to"]["m.in_reply_to"]) {
      const matrixRoomId = data.room_id;
      const matrixEventId = data.content["m.relates_to"]["m.in_reply_to"].event_id;
      const eventEntry = await this.bridge.getEventStore().getEntryByMatrixId(matrixRoomId, matrixEventId);
      if (eventEntry != null) {
        
        const quotedTimestamp = eventEntry.getRemoteRoomId();
        let quotedSenderNumber = eventEntry.getRemoteEventId();
        //We only save the "room", so we need to check if we are quoting ourselves
        if (eventEntry.get('sentByMe') == true) {
          quotedSenderNumber = this.myNumber.substring(this.myNumber.lastIndexOf("\\") +1);
        }
        
        const origFormated = data.content.formatted_body;        
        let endQuoteLinks = origFormated.lastIndexOf("</a><br>")+8;
        let endQuote = origFormated.lastIndexOf("</blockquote></mx-reply>");
        let quotedText = origFormated.substring(endQuoteLinks, endQuote);
      
        //TODO: Check if this is needed
        let startQuote = quotedText.lastIndexOf("</mx-reply>");
        if (startQuote > 0) {
          quotedText = quotedText.substring(startQuote+11, quotedText.lastIndexOf("</blockquote>"));
        }
        
        quote = {
          id: quotedTimestamp,
          author: quotedSenderNumber,
          authorUuid: null,
          text: quotedText,
          attachments: []
        };
        text = origFormated.substring(endQuote+24);
        
      }
      else {
        debug('no event found for', matrixRoomId, matrixEventId);
      }
    }
    
    let isGroup = false;
    const room = await this.bridge.getUserStore().getRemoteUser(thirdPartyRoomId);
    if ( room && room.isGroup == true) {
      thirdPartyRoomId = window.atob(thirdPartyRoomId);
      isGroup = true;
    }
    
    return this.client.sendMessage(thirdPartyRoomId, isGroup, text, [], quote).then(result => {
      let {timeStamp, members} = result;
      this.saveMessageEvents(data.room_id, data.event_id, timeStamp, members, true);
    });
  }
  
  
  //Signal uses timestamp as message id, and looks up recipients by timestamp before finding the one for the receipt.
  //Therefore we add it to the event store with roomId timestamp and eventId userNumber, so we can find event later
  saveMessageEvents(matrixRoomId, matrixEventId, timeStamp, members, sentMessage = false) {
    let message;
    
    //As we sent message we need to store ourselves as well
    if (sentMessage == true) {
      members.push(this.myNumber.substring(this.myNumber.lastIndexOf("\\") +1));
    }
    
    for ( let i = 0; i < members.length; i++ ) {
      message = new StoredEvent(matrixRoomId, matrixEventId, timeStamp, members[i], {sentByMe: sentMessage});
      this.bridge.getEventStore().upsertEvent(message);
    }
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
