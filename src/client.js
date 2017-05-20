// Haha... yeah this file is a bunch of nasty hacks I know...
// The reason for this is:
// a) i am basically dirty-porting the Chrome App to node.js
// b) my goal is purely to get it **working**
const qrcode = require('qrcode-terminal');
const Promise = require('bluebird');
process.on('unhandledRejection', function(reason, p){
  console.log("Possibly Unhandled Rejection at: Promise ", p, " reason: ", reason);
});
global.window = global;
window.location = { origin: "hacks" } // need this to avoid opaque origin error in indexeddb shim
global.XMLHttpRequest = require('xhr2');
global.moment = require('moment');
global._ = require('underscore');
global.Backbone = require('../lib/signaljs/components/backbone/backbone');
global.Backbone.$ = require('jquery-deferred');
global.Event = function(type) {
  this.type = type;
}
window.setUnreadCount = function(count) {
  console.log('unread count:', count);
}
window.clearAttention = function() {
  // called when unreadcount is set to 0
}

const setGlobalIndexedDbShimVars = require('indexeddbshim');
setGlobalIndexedDbShimVars(); // 

global.btoa = function (str) {
  return new Buffer(str).toString('base64');
};

global.Whisper = {};
Whisper.events = _.clone(Backbone.Events);
global.Backbone.sync = require('../lib/signaljs/components/indexeddb-backbonejs-adapter/backbone-indexeddb').sync;

window.globalListeners = {}
window.addEventListener = Whisper.events.on;
require('../lib/signaljs/database');
var WebCryptoOSSL = require("node-webcrypto-ossl");
global.crypto = new WebCryptoOSSL();

global.WebSocket = require('ws');

global.dcodeIO = {}
dcodeIO.Long = require('../lib/signaljs/components/long/dist/Long');
dcodeIO.ProtoBuf = require('../lib/signaljs/components/protobuf/dist/ProtoBuf');
dcodeIO.ByteBuffer = require('bytebuffer');

//require('./signaljs/components');
require('../lib/signaljs/signal_protocol_store');
require('../lib/signaljs/libtextsecure');

var fs = require('fs');

require('mkdirp').sync(process.cwd()+'/data');

function toArrayBuffer(buf) {
  var ab = new ArrayBuffer(buf.length);
  var view = new Uint8Array(ab);
  for (var i = 0; i < buf.length; ++i) {
    view[i] = buf[i];
  }
  return ab;
}

var Model = Backbone.Model.extend({ database: Whisper.Database });
var Item = Model.extend({ storeName: 'items' });
window.textsecure.storage.impl = {
  put: function(key, value) {
    fs.writeFileSync(process.cwd()+'/data/'+key, textsecure.utils.jsonThing(value));
    let item = new Item({ id: key, value });
    item.save();
  },
  get: function(key, defaultValue) {

    let ret;
    try {
      let raw = fs.readFileSync(process.cwd()+'/data/'+key);
      if (typeof raw === "undefined") {
        return defaultValue;
      } else {
        let val = JSON.parse(raw);
        if (key === "signaling_key") {
          return Buffer.from(val, 'ascii');
        } else if (key === "identityKey") {
          return {
            privKey: toArrayBuffer(Buffer.from(val.privKey, 'ascii')),
            pubKey: toArrayBuffer(Buffer.from(val.pubKey, 'ascii'))
          }
        } else {
          return val;
        }
      }
    } catch (e) {
      return defaultValue;
    }
  },
  remove: function(key) {
    try {
      fs.unlinkSync(process.cwd()+'/data/'+key);
    } catch (e) {
      
    }
  }
}

global.storage = window.textsecure.storage.impl;
Whisper.events.trigger('storage_ready');



require('../lib/signaljs/models/messages');
require('../lib/signaljs/registration');
//require('../lib/signaljs/wall_clock_listener');
require('../lib/signaljs/rotate_signed_prekey_listener');
require('../lib/signaljs/expiring_messages');

global.libphonenumber = require('../lib/signaljs/components/libphonenumber-api/libphonenumber_api-compiled');
require('../lib/signaljs/libphonenumber-util');

require('../lib/signaljs/models/conversations');
require('../lib/signaljs/conversation_controller');


var SERVER_URL = 'https://textsecure-service-ca.whispersystems.org';
var SERVER_PORTS = [80, 4433, 8443];
var messageReceiver;

global.getSocketStatus = function() {
    if (messageReceiver) {
        return messageReceiver.getStatus();
    } else {
        return -1;
    }
};


var accountManager;
global.getAccountManager = function() {
  if (!accountManager) {
    var USERNAME = storage.get('number_id');
    var PASSWORD = storage.get('password');
    accountManager = new textsecure.AccountManager(
      SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD
    );
    console.log('ad ev reg');
    accountManager.addEventListener('registration', function() {
      console.log('reg event!!!!');
      if (!Whisper.Registration.everDone()) {
        storage.put('safety-numbers-approval', false);
      }
      Whisper.Registration.markDone();
      console.log("dispatching registration event");
      Whisper.events.trigger('registration_done');
    });
  }
  return accountManager;
};

//Whisper.WallClockListener.init(Whisper.events);
Whisper.RotateSignedPreKeyListener.init(Whisper.events);
Whisper.ExpiringMessagesListener.init(Whisper.events);

global.getSyncRequest = function() {
    return new textsecure.SyncRequest(textsecure.messaging, messageReceiver);
};


function onContactReceived(ev) {
  console.log('contacrt revied');
    var contactDetails = ev.contactDetails;

    var c = new Whisper.Conversation({
        name: contactDetails.name,
        id: contactDetails.number,
        avatar: contactDetails.avatar,
        color: contactDetails.color,
        type: 'private',
        active_at: Date.now()
    });
    var error;
    if ((error = c.validateNumber())) {
        console.log(error);
        return;
    }

    ConversationController.create(c).save();
}

function onGroupReceived(ev) {
  console.log('grp receivped');
    var groupDetails = ev.groupDetails;
    var attributes = {
        id: groupDetails.id,
        name: groupDetails.name,
        members: groupDetails.members,
        avatar: groupDetails.avatar,
        type: 'group',
    };
    if (groupDetails.active) {
        attributes.active_at = Date.now();
    } else {
        attributes.left = true;
    }
    var conversation = ConversationController.create(attributes);
    conversation.save();
}

function onError(ev) {
    var e = ev.error;
    console.log(e);
    console.log(e.stack);
}

function onReadReceipt(ev) {
    var read_at   = ev.timestamp;
    var timestamp = ev.read.timestamp;
    var sender    = ev.read.sender;
    console.log('read receipt ', sender, timestamp);
}

function onDeliveryReceipt(ev) {
    var pushMessage = ev.proto;
    var timestamp = pushMessage.timestamp.toNumber();
    console.log(
        'delivery receipt from',
        pushMessage.source + '.' + pushMessage.sourceDevice,
        timestamp
    );
}

Whisper.events.on('unauthorized', function() {
  console.log('unauthorized!');
});
Whisper.events.on('reconnectTimer', function() {
  console.log('reconnect timer!');
});

const EventEmitter = require('events').EventEmitter;

class SignalClient extends EventEmitter {
  constructor(clientName="nodejs") {
    super();
    this.id = null;

    const link = () => {
      return getAccountManager().registerSecondDevice(
        (url)=> qrcode.generate(url),
        ()=> clientName
      ).catch(function(err) {
        console.log('link failed!\n', err.stack);
      });
    }

    const init = () => {
      if (messageReceiver) { messageReceiver.close(); }

      var USERNAME = storage.get('number_id');
      var PASSWORD = storage.get('password');
      var mySignalingKey = new Buffer(storage.get('signaling_key'));

      this.id = USERNAME;

      // initialize the socket and start listening for messages
      messageReceiver = new textsecure.MessageReceiver(
        SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD, mySignalingKey
      );

      [
        'message', // triggered when you receive a message on signal
        'sent', // triggered when a sent message synced from another client
      ].forEach((type) => {
        messageReceiver.addEventListener(type, ({data})=>this.emit(type, data));
      });

      messageReceiver.addEventListener('receipt', onDeliveryReceipt);
      messageReceiver.addEventListener('contact', onContactReceived);
      messageReceiver.addEventListener('group', onGroupReceived);
      messageReceiver.addEventListener('read', onReadReceipt);
      messageReceiver.addEventListener('error', onError);

      global.textsecure.messaging = new textsecure.MessageSender(
        SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD
      );

      return Promise.resolve(messageReceiver);
    }

    if (Whisper.Registration.everDone()) {
      init();
    }
    if (!Whisper.Registration.isDone()) {
      return link().then(() => init());
    }
  }

  // Remember, client's sent messages will NOT cause `message` or `sent` event!
  // however you WILL get delivery `receipt` events.
  // returns a promise
  sendMessage(phoneNumber, message, attachments=[]) {
    let timeStamp = new Date().getTime();
    let expireTimer = 0;
    return textsecure.messaging.sendMessageToNumber(
      phoneNumber,
      message,
      attachments,
      timeStamp,
      expireTimer
    );
  }
}

module.exports = SignalClient;

if (!module.parent) {
  let client = new SignalClient("matrix");
  client.on('message', data => {
    console.log(">>>message", data);
    console.log(">>>my id", client.id);
  });

  client.on('sent', data => {
    console.log(">>>sent", data);
    console.log(">>>my id", client.id);
  });

  //setTimeout(function() {
  //  client.sendMessage("+19498875144", "Does this cause sent trigger or what");
  //}, 2000);
}
