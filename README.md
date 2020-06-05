# signal-bridge [![#matrix-puppet-bridge:matrix.org](https://img.shields.io/matrix/matrix-puppet-bridge:matrix.org.svg?label=%23matrix-puppet-bridge%3Amatrix.org&logo=matrix&server_fqdn=matrix.org)](https://matrix.to/#/#matrix-puppet-bridge:matrix.org)

This is a Matrix bridge for Signal, messenger app by Open Whisper Systems.

It's based on the official [Signal-Desktop](https://github.com/WhisperSystems/Signal-Desktop) Client that has been ported to Node.js with minor modifications. They are necessary to remove things that are related to Electron that provides the graphical interface. You can find that here: https://github.com/witchent/Signal-Desktop / https://github.com/witchent/node-signal-client

## Features

- [x] Linking as a second device
- [x] Signal to Matrix direct text message
- [x] Matrix to Signal direct text message
- [x] Signal to Matrix group text message
- [x] Matrix to Signal group text message
- [x] Signal to Matrix image attachment message
- [x] Matrix to Signal image attachment message
- [x] Signal to Matrix file attachment message
- [x] Matrix to Signal file attachment message
- [x] contact list syncing
- [x] group syncing
- [x] show read receipts
- [x] send read receipts
- [x] show typing events
- [x] send typing events

## requirements

You need an iOS and Android phone with an existing Signal account that you are willing to link with the Signal client in this bridge.

required software:
- Node.js
- yarn
- python2
- npm

Please verify if `yarn -v` outputs something like `1.17.3`. If your output is `ERROR: There are no scenarios; must have at least one.` you have installed cmdtests instead of yarn. Please [install yarn](https://yarnpkg.com/en/docs/install) before you continue.

In the past we saw various issues with node versions different from the one that the official Signal-Desktop client uses. If you run into any issues you might try that version. The easiest way to change your version is using [n](https://www.npmjs.com/package/n). You can install it using `npm install -g n` and switch to Node.js 12.13.0 using `n 12.13.0`.

## installation

clone this repo

cd into the directory

run `npm install`

**Note:** Run neither the installation command nor the bridge itself with root rights.

## register/link with your signal mobile app

Before configuring the bridge with Matrix, **you need to setup the Signal link with your phone**.
Open up your Signal app and go to Settings and then Linked Devices.
You should see your camera preview open up.

In the terminal, run `npm run link` and you should soon see a giant QR code. Scan that with Signal.
As soon as no new messages appear on the terminal (SQL channel job ... (createOrUpdateSignedPreKey) succeeded in ...ms) you can ctrl+c out of the program and continue with configuring.

If you get an error, restart the node process so that you can try with a different QR (it may have expired).

If you ever need to unlink it and cleanup the data and keys, run `npm run clean`.
Make sure to delete the linked device from the Signal mobile app as well.

## configure

Copy `config.sample.json` to `config.json` and update it to match your setup.

## register the app service

Generate an `signal-registration.yaml` file with `node index.js -r -u "http://your-bridge-server:8090"`

Note: The 'registration' setting in the config.json needs to set to the path of this file. By default, it already is.

Copy this `signal-registration.yaml` file to your home server, then edit it, setting its url to point to your bridge server. e.g. `url: 'http://your-bridge-server.example.org:8090'`

Edit your homeserver.yaml file and update the `app_service_config_files` with the path to the `signal-registration.yaml` file.

Restart your HS.

Launch the bridge with `start.sh` or `node index.js`. If you want to run the bridge as a service you can use the `matrix-puppet-signal.service` file as a template for every systemd based operating system. You need to at least adjust WorkingDirectory, ExecStart and User.


## FAQ
See also https://github.com/witchent/matrix-puppet-bridge

### I get Error: Cannot find module 'matrix-puppet-signal/node_modules/sqlite3/lib/binding/node-v72-linux-x64/node_sqlite3.node' while building the app
Make sure you are using a new enough node version, either the newest (13.13.0 at the time of writing) or 12.13.0

### I get an error about "Cannot read property 'upsertEvent' of null"
Make sure your config.json contains the eventStore property, see config.sample.json

### I get an "M_UNKNOWN_TOKEN" error
Your access token from your matrix account is not working anymore. Replace it with a new one in your config.json



## Discussion, Help and Support

Join us in the [![Matrix Puppet Bridge](https://user-images.githubusercontent.com/13843293/52007839-4b2f6580-24c7-11e9-9a6c-14d8fc0d0737.png)](https://matrix.to/#/#matrix-puppet-bridge:matrix.org) room
