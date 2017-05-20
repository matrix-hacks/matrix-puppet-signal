const SignalClient = require('../src/client');
const fs = require('fs');
const mime = require('mime');

this.client = new SignalClient("matrix");

this.client.on('message', (data) => {
  console.log('>>>MESSAGE\n', data);
  const { source, message } = data;
  const payload = {
    roomId: source,
    senderId: source,
    senderName: source
  };
  if ( message.body ) {
    payload.text = message.body
  }
  if ( message.attachments.length > 0 ) {
    let att = message.attachments[0];
    console.log(att);
    const { contentType, data } = att;
    let buf = new Buffer(att.data);
    fs.writeFileSync(`/tmp/signal-attachment${mime.extension(contentType)}`, buf);
    console.log('WROTE');
  }
});

this.client.on('sent', data => {
  console.log('>>>SENT\n', data);
  const { destination, message: { body } } = data;
  const payload = {
    roomId: destination,
    senderId: undefined,
    senderName: destination,
    text: body
  };
});

this.client.start();
