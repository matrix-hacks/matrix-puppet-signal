# signal-bridge [![#matrix-puppet-bridge:matrix.org](https://img.shields.io/matrix/matrix-puppet-bridge:matrix.org.svg?label=%23matrix-puppet-bridge%3Amatrix.org&logo=matrix&server_fqdn=matrix.org)](https://matrix.to/#/#matrix-puppet-bridge:matrix.org)

This is a Matrix bridge for Signal, the secure messenger app by Open Whisper Systems.

It works through a dirty port of the [Signal Chrome App](https://github.com/WhisperSystems/Signal-Desktop) to Node.js, which serves as the client. You can find that here: https://github.com/matrix-hacks/node-signal-client

## features

- [x] Linking as a second device
- [x] Signal to Matrix direct text message
- [x] Matrix to Signal direct text message
- [x] Signal to Matrix direct image attachment message
- [x] Matrix to Signal direct image attachment message
- [x] group messaging (recieve)
- [x] group messaging (send)
- [ ] read receipts
- [ ] contact list syncing

## requirements

You need an iOS and Android phone with an existing Signal account that you are willing to link with the Signal client in this bridge.

## installation

clone this repo

cd into the directory

run `npm install`

## register/link with your signal mobile app

Before configuring the bridge with Matrix, **you need to setup the Signal link with your phone**.
Open up your Signal app and go to Settings and then Linked Devices.
You should see your camera preview open up.

In the terminal, run `npm run link` and you should soon see a giant QR code. Scan that with Signal.

If this throws an error, check the debug log for [this problem](https://github.com/matrix-hacks/matrix-puppet-signal/issues/8). If you're having this issue, npm did not completely install [signal-desktop](https://github.com/signalapp/Signal-Desktop), a dependency of a dependency. This happens because, at least in some npm versions, git repositories' git submodules are ignored. To install it manually, using git, run:
```bash
cd node_modules
rm -rf signal-desktop
git clone "https://github.com/signalapp/signal-desktop.git"
cd signal-desktop
git checkout v0.39.0
```

If you get an error, restart the node process so that you can try with a different QR (it may have expired).

If you ever need to unlink it and cleanup the data and keys, run `npm run clean`.
Make sure to delete the linked device from the Signal mobile app as well.

## configure

Copy `config.sample.json` to `config.json` and update it to match your setup

## register the app service

Generate an `signal-registration.yaml` file with `node index.js -r -u "http://your-bridge-server:8090"`

Note: The 'registration' setting in the config.json needs to set to the path of this file. By default, it already is.

Copy this `signal-registration.yaml` file to your home server, then edit it, setting its url to point to your bridge server. e.g. `url: 'http://your-bridge-server.example.org:8090'`

Edit your homeserver.yaml file and update the `app_service_config_files` with the path to the `signal-registration.yaml` file.

Launch the bridge with ```node index.js```.

Restart your HS.

## Discussion, Help and Support

Join us in the [![Matrix Puppet Bridge](https://user-images.githubusercontent.com/13843293/52007839-4b2f6580-24c7-11e9-9a6c-14d8fc0d0737.png)](https://matrix.to/#/#matrix-puppet-bridge:matrix.org) room

# TODO
* Be able to originate conversations from the Matrix side.
