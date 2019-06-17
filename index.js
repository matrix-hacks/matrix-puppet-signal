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
      const { source, message } = ev.data;
      let room = source;
      if ( message.group != null)
        room = message.group.id;
      this.handleSignalMessage({
        roomId: room,
        senderId: source,
        senderName: source,
      }, message);
    });

    this.client.on('sent', (ev) => {
      const { destination, message } = ev.data;
      this.handleSignalMessage({
        roomId: destination,
        senderId: undefined,
        senderName: destination,
      }, message);
    });

this.client.on('group', (ev)=>{
  console.log('group received', ev.groupDetails);
});

    return this.client.start();
  }
  handleSignalMessage(payload, message) {
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
  getThirdPartyRoomDataById(phoneNumber) {
    return Promise.resolve({
      name: '',
      topic: "Signal Direct Message"
    })
  }
  sendReadReceiptAsPuppetToThirdPartyRoomWithId() {
    // no-op for now
  }
  
  sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    return download.getTempfile(data.url, { tagFilename: true }).then(({path}) => {
      const img = path;
      let fs = require('fs');
      let image = fs.readFileSync(img);
      return this.client.sendMessage( id, data.text, [{contentType : data.mimetype, size : data.size, data : image} ] );
    });  
  }

stringToArrayBuffer(str) {
    if (typeof str !== 'string') {
        throw new Error('Passed non-string to stringToArrayBuffer');
    }
    var res = new ArrayBuffer(str.length);
    var uint = new Uint8Array(res);
    for (var i = 0; i < str.length; i++) {
        uint[i] = str.charCodeAt(i);
    }
    return res;
}

  sendMessageAsPuppetToThirdPartyRoomWithId(id, text) {
console.log(this.client.syncGroups());
console.log(id);
    if ( id.match(/^÷/) ) {
      console.log("sending to group");
      return this.client.sendMessageToGroup(this.stringToArrayBuffer(id), text);
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

