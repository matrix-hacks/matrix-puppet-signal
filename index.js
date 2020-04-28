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
        room = window.btoa(message.group.id);
        members = message.group.members;
      }
      if(message.group && message.group.name) {
        console.log('added to new group');
        let id = window.btoa(message.group.id);
        let group = { name: message.group.name };
        if(message.group.avatar) {
          this.client.downloadAttachment(message.group.avatar).then(data => {
            group.avatar = {type: 'image/jpeg', buffer: data.data};
            this.groups.set(id, group);
            this.getOrCreateMatrixRoomFromThirdPartyRoomId(id).then((matrixRoomId) => {
              const otherPeople = message.group.members.filter(memb => !memb.e164.match(this.myNumber));
              group.members = [];
              for (let i = 0; i < otherPeople.length; ++i) {
                group.members.push(otherPeople[i].e164);
              }
    
              Promise.map(group.members, (member) => {
                return this.getIntentFromThirdPartySenderId(member).then(ghost=>{
                  return this.puppet.getClient().invite(matrixRoomId, ghost.client.credentials.userId).then(() => {
                    return ghost._ensureJoined(matrixRoomId).then(()=>{
                      console.log('joined ghost', member);
                    }, (err)=>{
                      console.log('failed to join ghost', member, matrixRoomId, err);
                    });
                  });
                });
              });
            });
          });
        } else {
          this.groups.set(id, group);
          this.getOrCreateMatrixRoomFromThirdPartyRoomId(id).then((matrixRoomId) => {
            const otherPeople = message.group.members.filter(memb => !memb.e164.match(this.myNumber));
            group.members = [];
            for (let i = 0; i < otherPeople.length; ++i) {
              group.members.push(otherPeople[i].e164);
            }
  
            Promise.map(group.members, (member) => {
              return this.getIntentFromThirdPartySenderId(member).then(ghost=>{
                return this.puppet.getClient().invite(matrixRoomId, ghost.client.credentials.userId).then(() => {
                  return ghost._ensureJoined(matrixRoomId).then(()=>{
                    console.log('joined ghost', member);
                  }, (err)=>{
                    console.log('failed to join ghost', member, matrixRoomId, err);
                  });
                });
              });
            });
          });
        }
        return;
      }
      this.handleSignalMessage({
        roomId: room,
        senderId: source,
      }, message, timestamp, members);
    });

    this.client.on('sent', (ev) => {
      const { destination, message, timestamp } = ev.data;
      let room = destination;
      let members = [destination];
      if ( message.group != null ) {
        room = window.btoa(message.group.id);
        members = message.group.members;
      }
      this.handleSignalMessage({
        roomId: room,
        senderId: undefined,
        senderName: destination,
      }, message, timestamp, members);
    });

    this.client.on('read', (ev) => {
      const { timestamp, reader } = ev.read;
      console.log("read event", timestamp, reader);
      this.handleSignalReadReceipt(timestamp, reader);
    });

    this.groups = new Map(); // abstract storage for groups
    // triggered when we run syncGroups
    this.client.on('group', (ev) => {
      console.log('group received', ev.groupDetails);
      if(!ev.groupDetails.active) {
        return;
      }
      let id = window.btoa(ev.groupDetails.id);
      let group = { name: ev.groupDetails.name };
      if(ev.groupDetails.avatar) {
        group.avatar = {type: 'image/jpeg', buffer: ev.groupDetails.avatar.data};
      }
      this.groups.set(id, group);
      this.getOrCreateMatrixRoomFromThirdPartyRoomId(id).then((matrixRoomId) => {
        const otherPeople = ev.groupDetails.members.filter(memb => !memb.e164.match(this.myNumber));
        group.members = [];
        for (let i = 0; i < otherPeople.length; ++i) {
          group.members.push(otherPeople[i].e164);
        }
        
        Promise.map(group.members, (senderId) => {
          return this.getIntentFromThirdPartySenderId(senderId).then(ghost=>{
            return this.puppet.getClient().invite(matrixRoomId, ghost.client.credentials.userId).then(() => {
              return ghost._ensureJoined(matrixRoomId).then(()=>{
                console.log('joined ghost', senderId);
              }, (err)=>{
                console.log('failed to join ghost', senderId, matrixRoomId, err);
              });
            });
          });
        });
      });
    });

    this.contacts = new Map();
    this.client.on('contact', (ev) => {
      console.log('contact received', ev.contactDetails);
      let contact = {};
      contact.userId = ev.contactDetails.number;
      contact.senderName = ev.contactDetails.name;
      contact.name = ev.contactDetails.name;

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
      console.log('typing event', sender, timestamp);
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
  handleSignalMessage(payload, message, timeStamp, members = []) {
    this.handleTypingEvent(payload.roomId, false, payload.roomId);
    if ( message.body ) {
      payload.text = message.body
    }
    //Undefined text means file will not get through, so we just set it to empty string
    else {
      payload.text = "";
    }
    if (!payload.senderName) {  //Make sure senders have a name so they show up
      payload.senderName = "Unnamed";
    }
    if ( message.attachments.length === 0 ) {
      if(payload.text == null) {
        return;
      }
      this.handleThirdPartyRoomMessage(payload).then(matrixEventId => {
        const matrixRoomId = this.getOrCreateMatrixRoomFromThirdPartyRoomId(payload.roomId).then(matrixRoomId => {
          let message;
          for ( let i = 0; i < members.length; i++ ) {
    //         //Signal uses timestamp as message id, and looks up recipients by timestamp before finding the one for the receipt.
    //         //Therefore we add it to the event store with roomId timestamp and eventId user, so we can find event later
            message = new StoredEvent(matrixRoomId, matrixEventId, timeStamp, members[i]);
            this.bridge.getEventStore().upsertEvent(message);
          }
        });
      });
    } else {
      for ( let i = 0; i < message.attachments.length; i++ ) {
        let att = message.attachments[i];
        this.client.downloadAttachment(att).then(data => {
          payload.buffer = new Buffer.from(data.data);
          payload.mimetype = data.contentType;
          this.handleThirdPartyRoomMessageWithAttachment(payload).then(matrixEventId => {
            const matrixRoomId = this.getOrCreateMatrixRoomFromThirdPartyRoomId(payload.roomId).then(matrixRoomId => {
              let message;
              for ( let i = 0; i < members.length; i++ ) {
                message = new StoredEvent(matrixRoomId, matrixEventId, timeStamp, members[i]);
                this.bridge.getEventStore().upsertEvent(message);
              }
            });
          });
        }); 
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
      this.contacts.get(id).name;
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
  async sendReadReceiptAsPuppetToThirdPartyRoomWithId(id) {
    let timeStamp = await new Date().getTime();
    
    console.log("sending read receipts for " + id);

    // mark messages as read in your signal clients
    await this.client.syncReadReceipts(id, this.groups.has(id), timeStamp, config.sendReadReceipts);

    return true;
  }

  async sendTypingEventAsPuppetToThirdPartyRoomWithId(id, status) {
      await this.client.sendTypingMessage(id, this.groups.has(id), status, config.sendTypingEvents);
  }

  sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    return this.sendFileMessageAsPuppetToThirdPartyRoomWithId(id, data);
  }

  sendFileMessageAsPuppetToThirdPartyRoomWithId(thirdPartyRoomId, data) {
    data.text = "";
    if (this.groups.has(thirdPartyRoomId)) {
      thirdPartyRoomId = window.atob(id);
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
