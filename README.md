# signal-bridge

This is a Matrix bridge for WhisperSystems' Signal

It works through a dirty port of the [Signal Chrome App](https://github.com/WhisperSystems/Signal-Desktop) to Node.js, which serves as the client. You can find that in the `src` directory.

## features

- [x] Linking as a second device
- [x] Signal to Matrix direct text message
- [x] Matrix to Signal direct text message
- [x] Signal to Matrix direct image attachment message
- [ ] Matrix to Signal direct image attachment message
- [ ] group messaging
- [ ] read receipts
- [ ] contact list syncing

## requirements

You need an iOS and Android phone with an existing Signal account that you are willing to link with the Signal client in this bridge.

## installation

clone this repo

cd into the directory

run `npm install`

## configure

Copy `config.sample.json` to `config.json` and update it to match your setup

## register the app service

Generate an `signal-registration.yaml` file with `node index.js -r -u "http://your-bridge-server:8090"`

Note: The 'registration' setting in the config.json needs to set to the path of this file. By default, it already is.

Copy this `signal-registration.yaml` file to your home server, then edit it, setting its url to point to your bridge server. e.g. `url: 'http://your-bridge-server.example.org:8090'`

Edit your homeserver.yaml file and update the `app_service_config_files` with the path to the `signal-registration.yaml` file.

Launch the bridge with ```node index.js```.

Restart your HS.

## register/link with your signal mobile app

Before the bridge can communicate over the Signal network, you need to link it with your phone.
Open up your Signal app and go to Settings and then Linked Devices.
You should see your camera preview open up.

In the terminal where you ran `node` you should see a giant QR code. Scan that with Signal.
If you get an error, restart the node process so that you can try with a different QR (it may have expired).
Once you've done that, the bridge will connect to the Signal network normally.

If you ever need to unlink it and cleanup the data and keys, run `make clean`.
Make sure to delete the linked device from the Signal mobile app as well.

# TODO
* Be able to originate conversations from the Matrix side.
