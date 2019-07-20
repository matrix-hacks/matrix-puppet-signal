const {
  MatrixAppServiceBridge: {
    Cli, AppServiceRegistration
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
      if ( message.group != null ) {
        room = window.btoa(message.group.id);
      }
      this.handleSignalMessage({
        roomId: room,
        senderId: source,
      }, message, timestamp);
    });

    this.client.on('sent', (ev) => {
      const { destination, message, timestamp } = ev.data;
      let room = destination;
      if ( message.group != null ) {
        room = window.btoa(message.group.id);
      }
      this.handleSignalMessage({
        roomId: room,
        senderId: undefined,
        senderName: destination,
      }, message, timestamp);
    });

    this.groups = new Map(); // abstract storage for groups
    // triggered when we run syncGroups
    this.client.on('group', (ev) => {
      console.log('group received', ev.groupDetails);
      let id = window.btoa(ev.groupDetails.id);
      let group = { name: ev.groupDetails.name };
      this.getOrCreateMatrixRoomFromThirdPartyRoomId(id).then((matrixRoomId) => {
        const otherPeople = ev.groupDetails.members.filter(phoneNumber => !phoneNumber.match(this.myNumber));
        group.members = otherPeople;

        Promise.map(otherPeople, (senderId) => {
          return this.getIntentFromThirdPartySenderId(senderId).then(ghost=>{
            return ghost.join(matrixRoomId).then(()=>{
              console.log('joined ghost', senderId);
            }, (err)=>{
              console.log('failed to join ghost', senderId, matrixRoomId, err);
            });
          });
        });
      });
      this.groups.set(id, group);
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
        group = btoa(ev.typing.groupId);
      }
      this.handleTypingEvent(sender,status,group);
    });

    setTimeout(this.client.syncGroups, 5000); // request for sync groups 
    setTimeout(this.client.syncContacts, 10000); // request for sync contacts

    this.history = [];

    return this.client.start();
  }
  handleSignalMessage(payload, message, timestamp) {
    this.history.push({sender: payload.senderId, timestamp: new Date(timestamp).getTime(), room: payload.roomId});
    if ( message.body ) {
      payload.text = message.body
    }
    if ( message.attachments.length === 0 ) {
      return this.handleThirdPartyRoomMessage(payload);
    } else {
      for ( let i = 0; i < message.attachments.length; i++ ) {
        let att = message.attachments[i];
		    payload.buffer = new Buffer.from(att.data);
		    payload.mimetype = att.contentType;
        this.handleThirdPartyRoomMessageWithAttachment(payload);
      }
      return true;
    }
  }
  async handleTypingEvent(sender,status,group) {
    try {
      let id = sender;
      if (group) {
        id = group;
      }
      const ghostIntent = await this.getIntentFromThirdPartySenderId(sender);
      const matrixRoomId = await this.getOrCreateMatrixRoomFromThirdPartyRoomId(id);
      // HACK: copy from matrix-appservice-bridge/lib/components/indent.js
      // client can get timeout value, but intent does not support this yet.
      await ghostIntent._ensureJoined(matrixRoomId);
      await ghostIntent._ensureHasPowerLevelFor(matrixRoomId, "m.typing");
      return ghostIntent.client.sendTyping(matrixRoomId, status, 60000);
    } catch (err) {
      debug('could not send typing event', err.message);
    }
  }
  getThirdPartyRoomDataById(id) {
    let name = "";
    let topic = "Signal Direct Message";
    if ( this.contacts.has(id) ) {
      this.contacts.get(id).name;
    }
    if ( this.groups.has(id) ) {
      name = this.groups.get(id).name;
      topic = "Signal Group Message"
    }
    return Promise.resolve({
      name: name,
      topic: topic
    })
  }
  getThirdPartyUserDataById(id) {
    if(this.contacts.has(id)) {
      return this.contacts.get(id);
    } else {
      return {senderName: id};
    }
  }
  sendReadReceiptAsPuppetToThirdPartyRoomWithId(id) {
    let read = [];
    let receipts = [];
    let sender = id;
    for(let i = 0; i < this.history.length; i++) {
      if(this.history[i].room == id) {
        sender = this.history[i].sender;
        read.push(this.history[i]);
        receipts.push(this.history[i].timestamp);
        this.history.splice(i, 1);
        i--;
      }
    }
    if(read.length === 0) {
      return true;
    }
    console.log("sending " + read.length + "receipts");

    // mark messages as read in your signal clients
    this.client.syncReadMessages(read);

    // send read receipts to your contacts if you wish to
    if(config.sendReadReceipts) {
        this.client.sendReadReceipts(sender, receipts);
    }

    return true;
  }

  sendTypingEventAsPuppetToThirdPartyRoomWithId(id, status) {
    if(config.sendTypingEvents) {
      let payload = { isTyping: status, timestamp: new Date().getTime() };
      if(this.groups.has(id)) {
        payload.groupId = window.atob(id);
        payload.groupNumbers = this.groups.get(id).members;
      } else {
        payload.recipientId = id;
      }
      return this.client.sendTypingMessage(payload);
    }
  }

  sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    return this.sendFileMessageAsPuppetToThirdPartyRoomWithId(id, data);
  }

  sendFileMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    data.text = "";
    return download.getTempfile(data.url, { tagFilename: true }).then(({path}) => {
      const img = path;
      let image = fs.readFileSync(img);
      if(this.groups.has(id)) {
        return this.client.sendMessageToGroup( window.atob(id), data.text, [{contentType : data.mimetype, size : data.size, data : image} ] );
      } else {
        return this.client.sendMessage( id, data.text, [{contentType : data.mimetype, size : data.size, data : image} ] );
      }
    });
  }

  sendMessageAsPuppetToThirdPartyRoomWithId(id, text) {
    if(this.groups.has(id)) {
      return this.client.sendMessageToGroup(window.atob(id), text);
    } else {
      return this.client.sendMessage(id, text);
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

