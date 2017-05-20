const {
  MatrixAppServiceBridge: {
    Cli, AppServiceRegistration
  },
  Puppet,
  MatrixPuppetBridgeBase
} = require("matrix-puppet-bridge");
const Promise = require('bluebird');
const SignalClient = require('./src/client');
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
    console.log('startup');
    this.client = new SignalClient("matrix");
    this.allowNullSenderName = true;

    this.client.on('message', (data) => {
      const { source, message: { body } } = data;
      const payload = {
        roomId: source,
        senderId: source,
        text: body
      };
      debug(payload);
      return this.handleThirdPartyRoomMessage(payload);
    });

    this.client.on('sent', data => {
      const { destination, message: { body } } = data;
      const payload = {
        roomId: destination,
        senderId: undefined,
        text: body
      };
      debug(payload);
      return this.handleThirdPartyRoomMessage(payload);
    });

    return this.client.start();
  }
  getThirdPartyRoomDataById(phoneNumber) {
    return Promise.resolve({
      name: phoneNumber,
      topic: "Signal Direct Message"
    })
  }
  sendReadReceiptAsPuppetToThirdPartyRoomWithId() {
    // no-op for now
  }
  sendMessageAsPuppetToThirdPartyRoomWithId(id, text) {
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

