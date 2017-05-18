const Promise = require('bluebird');
global.window = global;
window.location = { origin: "hacks" } // need this to avoid opaque origin error in indexeddb shim
global.XMLHttpRequest = require('xhr2');
global.moment = require('moment');
global.Backbone = require('./lib/signaljs/components/backbone/backbone');
global.Backbone.$ = require('jquery-deferred');
global.Event = function(type) {
  this.type = type;
}

const setGlobalIndexedDbShimVars = require('indexeddbshim');
setGlobalIndexedDbShimVars(); // 

global.btoa = function (str) {
  return new Buffer(str).toString('base64');
};

global.Whisper = {};
global.Backbone.sync = require('./lib/signaljs/components/indexeddb-backbonejs-adapter/backbone-indexeddb').sync;

require('./lib/signaljs/database');
var WebCryptoOSSL = require("node-webcrypto-ossl");
global.crypto = new WebCryptoOSSL();

global.WebSocket = require('ws');

global.dcodeIO = {}
dcodeIO.Long = require('./lib/signaljs/components/long/dist/Long');
dcodeIO.ProtoBuf = require('./lib/signaljs/components/protobuf/dist/ProtoBuf');
dcodeIO.ByteBuffer = require('./lib/signaljs/components/bytebuffer/dist/ByteBufferAB');

global._ = require('underscore');

//require('./signaljs/components');
require('./lib/signaljs/signal_protocol_store');
require('./lib/signaljs/libtextsecure');

var fs = require('fs');

window.textsecure.storage.impl = {
  put: function(key, value) {
    fs.writeFileSync(__dirname+'/data/'+key, textsecure.utils.jsonThing(value));
  },
  get: function(key, defaultValue) {
    let ret;
    try {
      let raw = fs.readFileSync(__dirname+'/data/'+key);
      if (typeof raw === "undefined") {
        return defaultValue;
      } else {
        let val = JSON.parse(raw);
        if (key === "signaling_key") {
          return Buffer.from(val, 'ascii');
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
      fs.unlinkSync(__dirname+'/data/'+key);
    } catch (e) {
      
    }
  }
}

global.storage = window.textsecure.storage.impl;


require('./lib/signaljs/models/messages');
require('./lib/signaljs/registration');
//require('./lib/signaljs/wall_clock_listener');
require('./lib/signaljs/rotate_signed_prekey_listener');
require('./lib/signaljs/expiring_messages');

global.libphonenumber = require('./lib/signaljs/components/libphonenumber-api/libphonenumber_api-compiled');
require('./lib/signaljs/libphonenumber-util');


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

const EventEmitter = require('events').EventEmitter;

Whisper.events = _.clone(Backbone.Events);

var accountManager;
global.getAccountManager = function() {
    if (!accountManager) {
        var USERNAME = storage.get('number_id');
        var PASSWORD = storage.get('password');
        accountManager = new textsecure.AccountManager(
            SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD
        );
    }
    return accountManager;
};

//Whisper.WallClockListener.init(Whisper.events);
Whisper.RotateSignedPreKeyListener.init(Whisper.events);
Whisper.ExpiringMessagesListener.init(Whisper.events);

global.getSyncRequest = function() {
    return new textsecure.SyncRequest(textsecure.messaging, messageReceiver);
};

function init(firstRun) {
    if (messageReceiver) { messageReceiver.close(); }

    var USERNAME = storage.get('number_id');
    var PASSWORD = storage.get('password');
    var mySignalingKey = new Buffer(storage.get('signaling_key'));

    // initialize the socket and start listening for messages
    messageReceiver = new textsecure.MessageReceiver(
        SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD, mySignalingKey
    );
    messageReceiver.addEventListener('message', onMessageReceived);
    messageReceiver.addEventListener('receipt', onDeliveryReceipt);
    messageReceiver.addEventListener('contact', onContactReceived);
    messageReceiver.addEventListener('group', onGroupReceived);
    messageReceiver.addEventListener('sent', onSentMessage);
    messageReceiver.addEventListener('read', onReadReceipt);
    messageReceiver.addEventListener('error', onError);

    global.textsecure.messaging = new textsecure.MessageSender(
        SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD
    );

  var syncRequest = new textsecure.SyncRequest(textsecure.messaging, messageReceiver);
  Whisper.events.trigger('contactsync:begin');
  syncRequest.addEventListener('success', function() {
    console.log('sync successful');
    storage.put('synced_at', Date.now());
    Whisper.events.trigger('contactsync');
  });
  syncRequest.addEventListener('timeout', function() {
    console.log('sync timed out');
    Whisper.events.trigger('contactsync');
  });
}

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

function onMessageReceived(ev) {
  console.log('message received');
    var data = ev.data;
    var message = initIncomingMessage(data.source, data.timestamp);
    message.handleDataMessage(data.message);
}

function onSentMessage(ev) {
  console.log('message sent');
    var now = new Date().getTime();
    var data = ev.data;

    var message = new Whisper.Message({
        source         : textsecure.storage.user.getNumber(),
        sent_at        : data.timestamp,
        received_at    : now,
        conversationId : data.destination,
        type           : 'outgoing',
        sent           : true,
        expirationStartTimestamp: data.expirationStartTimestamp,
    });

    message.handleDataMessage(data.message);
}

function initIncomingMessage(source, timestamp) {
  console.log('init incoming msg');
    var now = new Date().getTime();

    var message = new Whisper.Message({
        source         : source,
        sent_at        : timestamp,
        received_at    : now,
        conversationId : source,
        type           : 'incoming',
        unread         : 1
    });

    return message;
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
    Whisper.ReadReceipts.add({
        sender    : sender,
        timestamp : timestamp,
        read_at   : read_at
    });
}

function onDeliveryReceipt(ev) {
  console.log('deliv receipt!');
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

function linkAccount() {
  getAccountManager().registerSecondDevice(
    function setProvisioningUrl(url) {
      console.log(url);
    },
    function confirmNumber(num) {
      console.log('confirm number:', num);
      // resolve with the name you want to give it...
      return Promise.resolve("matrix");
    }
  ).catch(function(err) {
    console.log('link failed!\n', err.stack);
  });
}

const args = require('minimist')(process.argv);

const [bin, script, cmd] = args._;

if (cmd === "link") {
  linkAccount();
} else {
  init();
}


process.on('unhandledRejection', function(reason, p){
  console.log("Possibly Unhandled Rejection at: Promise ", p, " reason: ", reason);
  // application specific logging here
});
