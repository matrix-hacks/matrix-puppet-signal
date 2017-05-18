const Promise = require('bluebird');
global.window = global;
window.location = { origin: "hacks" } // need this to avoid opaque origin error in indexeddb shim
global.XMLHttpRequest = require('xhr2');
global.moment = require('moment');
global.Backbone = require('./lib/signaljs/components/backbone/backbone');
global.Backbone.$ = require('jquery-deferred');

const setGlobalIndexedDbShimVars = require('indexeddbshim');
setGlobalIndexedDbShimVars(); // 

global.btoa = function (str) {
  return new Buffer(str).toString('base64');
};
global.storage = require('node-persist');
storage.initSync({ dir: 'persist' });
global.localStorage = storage;
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

Whisper.events = new EventEmitter();

var accountManager;
global.getAccountManager = function() {
    if (!accountManager) {
        var USERNAME = storage.get('number_id');
        var PASSWORD = storage.get('password');
        accountManager = new textsecure.AccountManager(
            SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD
        );
        accountManager.addEventListener('registration', function() {
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


if (Whisper.Registration.isDone()) {
  extension.keepAwake();
  init();
}

console.log("listening for registration events");
Whisper.events.on('registration_done', function() {
  console.log("handling registration event");
  init(true);
});

//Whisper.WallClockListener.init(Whisper.events);
Whisper.RotateSignedPreKeyListener.init(Whisper.events);
Whisper.ExpiringMessagesListener.init(Whisper.events);

global.getSyncRequest = function() {
    return new textsecure.SyncRequest(textsecure.messaging, messageReceiver);
};

function init(firstRun) {
    global.removeEventListener('online', init);
    if (!Whisper.Registration.isDone()) { return; }

    if (messageReceiver) { messageReceiver.close(); }

    var USERNAME = storage.get('number_id');
    var PASSWORD = storage.get('password');
    var mySignalingKey = storage.get('signaling_key');

  console.log('init', USERNAME);

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

    if (firstRun === true && textsecure.storage.user.getDeviceId() != '1') {
        if (!storage.get('theme-setting') && textsecure.storage.get('userAgent') === 'OWI') {
            storage.put('theme-setting', 'ios');
        }
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
}

function onContactReceived(ev) {
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
    var data = ev.data;
    var message = initIncomingMessage(data.source, data.timestamp);
    message.handleDataMessage(data.message);
}

function onSentMessage(ev) {
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

    if (e.name === 'HTTPError' && (e.code == 401 || e.code == 403)) {
        Whisper.Registration.remove();
        Whisper.events.trigger('unauthorized');
        extension.install();
        return;
    }

    if (e.name === 'HTTPError' && e.code == -1) {
        // Failed to connect to server
        if (navigator.onLine) {
            console.log('retrying in 1 minute');
            setTimeout(init, 60000);

            Whisper.events.trigger('reconnectTimer');
        } else {
            console.log('offline');
            messageReceiver.close();
            global.addEventListener('online', init);
        }
        return;
    }

    if (ev.proto) {
        if (e.name === 'MessageCounterError') {
            // Ignore this message. It is likely a duplicate delivery
            // because the server lost our ack the first time.
            return;
        }
        var envelope = ev.proto;
        var message = initIncomingMessage(envelope.source, envelope.timestamp.toNumber());
        message.saveErrors(e).then(function() {
            ConversationController.findOrCreatePrivateById(message.get('conversationId')).then(function(conversation) {
                conversation.set({
                    active_at: Date.now(),
                    unreadCount: conversation.get('unreadCount') + 1
                });

                var conversation_timestamp = conversation.get('timestamp');
                var message_timestamp = message.get('timestamp');
                if (!conversation_timestamp || message_timestamp > conversation_timestamp) {
                    conversation.set({ timestamp: message.get('sent_at') });
                }
                conversation.save();
                conversation.trigger('newmessage', message);
                conversation.notify(message);
            });
        });
        return;
    }

    throw e;
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
    var pushMessage = ev.proto;
    var timestamp = pushMessage.timestamp.toNumber();
    console.log(
        'delivery receipt from',
        pushMessage.source + '.' + pushMessage.sourceDevice,
        timestamp
    );

    Whisper.DeliveryReceipts.add({
        timestamp: timestamp, source: pushMessage.source
    });
}

Whisper.events.on('unauthorized', function() {
    if (owsDesktopApp.inboxView) {
        owsDesktopApp.inboxView.networkStatusView.update();
    }
});
Whisper.events.on('reconnectTimer', function() {
    if (owsDesktopApp.inboxView) {
        owsDesktopApp.inboxView.networkStatusView.setSocketReconnectInterval(60000);
    }
});

getAccountManager().registerSecondDevice(
  function setProvisioningUrl(url) {
    console.log(url);
  },
  function confirmNumber(num) {
    console.log('confirm number:', num);
    // resolve with the name you want to give it...
    return Promise.resolve("matrix");
  },
  function incrementCounter() {
    console.log('increment counter called');
  }
).catch(function(err) {
  console.log('disconnected');
  console.log('err', err.stack);
});
