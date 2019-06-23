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

class App extends MatrixPuppetBridgeBase {
  getServicePrefix() {
    return "signal";
  }
  getServiceName() {
    return "Signal";
  }
  initThirdPartyClient() {
    this.client = new SignalClient("matrix");

    this.client.on('message', (ev) => {
      const { source, message, timestamp } = ev.data;
      let room = source;
      if ( message.group != null)
        room = message.group.id;
      this.handleSignalMessage({
        roomId: room,
        senderId: source,
        senderName: source,
      }, message, timestamp);
    });

    this.client.on('sent', (ev) => {
      const { destination, message, timestamp } = ev.data;
      this.handleSignalMessage({
        roomId: destination,
        senderId: undefined,
        senderName: destination,
      }, message, timestamp);
    });
	
    this.groups = new Map(); // abstract storage for groups
    // triggered when we run syncGroups
    this.client.on('group', (ev) => {
      console.log('group received', ev.groupDetails);
      let id = ev.groupDetails.id;
      let name = ev.groupDetails.name.replace(/\s/g, '_');
      this.groups.set(id, name);
    });
	
	this.contacts = new Map();
    this.client.on('contact', (ev) => {
      console.log('contact received', ev.contactDetails);
      this.contacts.set(ev.contactDetails.number, ev.contactDetails.name);
    });
	
    setTimeout(this.client.syncGroups, 5000); // request for sync groups 
    setTimeout(this.client.syncContacts, 10000); // request for sync contacts

    this.history = [];

    return this.client.start();
  }
  handleSignalMessage(payload, message, timestamp) {
    this.history.push({sender: payload.senderId, timestamp: new Date(timestamp).getTime()});
    if ( message.body ) {
      payload.text = message.body
    }
    if ( message.attachments.length === 0 ) {
      return this.handleThirdPartyRoomMessage(payload);
    } else {
      for ( let i = 0; i < message.attachments.length; i++ ) {
        let att = message.attachments[i];
		payload.buffer = new Buffer(att.data);
		payload.mimetype = att.contentType;
		if ( payload.mimetype.match(/^image/) ) {
		  this.handleThirdPartyRoomImageMessage(payload);
		} else {
		  this.sendStatusMsg({}, "dont know how to deal with filetype", payload);
		}
      }
      return true;
    }
  }
  getThirdPartyRoomDataById(id) {
    let name = this.contacts.get(id);
    if ( !name ) 
      name = this.groups.get(id);
    return Promise.resolve({
      name: name,
      topic: "Signal Direct Message"
    })
  }
  sendReadReceiptAsPuppetToThirdPartyRoomWithId(id) {
    let r = [];
    for(let i = 0; i < this.history.length; i++) {
      if(this.history[i].sender == id) {
        r.push(this.history[i]);
        this.history.splice(i, 1);
        i--;
      }
    }
    console.log("sending " + r.length + "receipts");
    return this.client.markRead(r);
  }
  
  sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    return download.getTempfile(data.url, { tagFilename: true }).then(({path}) => {
      const img = path;
      let fs = require('fs');
      let image = fs.readFileSync(img);
      if(this.groups.has(id))
        return this.client.sendMessageToGroup( id, data.text, [{contentType : data.mimetype, size : data.size, data : image} ] );
      else
        return this.client.sendMessage( id, data.text, [{contentType : data.mimetype, size : data.size, data : image} ] );
    });  
  }

  sendMessageAsPuppetToThirdPartyRoomWithId(id, text) {
    if(this.groups.has(id))
      return this.client.sendMessageToGroup(id, text);
    else
      return this.client.sendMessage(id, text);
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

