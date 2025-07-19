Github-CI: [![Build Status][build_status]][build_link]

[build_status]: ./../../actions/workflows/build.yml/badge.svg
[build_link]: ./../../actions/workflows/build.yml

# NanoVer Web

A proof of concept or prototype of NanoVer for the browser and WebXR.

## Developer setup

### Install (Windows)

Install [node.js](https://nodejs.org/), [git](https://git-scm.com/), [Visual Studio Code](https://code.visualstudio.com/).

```PowerShell
winget install -e --id OpenJS.NodeJS
winget install -e --id Git.Git
winget install -e --id Microsoft.VisualStudioCode
```

Clone this repo and install its dependencies:

```PowerShell
git clone https://github.com/IRL2/nanover-web.git
cd nanover-web
npm install
```

### Developing

Run a live server that opens a new browser tab and refreshes when you edit the code:

```bash
npm run dev
```

Build the standalone web package:

```bash
npm run build
```

Preview the standalone web package:
```bash
npm run preview
```

### WebXR and headset

For security, WebXR requires that the page be served over HTTPS, so you will need to configure the Live Server extension to use an SSL certificate.

To do so, install [OpenSSL](https://slproweb.com/products/Win32OpenSSL.html#downloads), and generate a private key and certificate:

* Either choose "nanover" as the passphrase or update it later in [the vite config](./vite.config.js)
* Skip all data input except `common name` which should be `localhost`

```
openssl genrsa -aes256 -out localhost.key 2048
openssl req -days 3650 -new -newkey rsa:2048 -key localhost.key -x509 -out localhost.pem
```

### NanoVer server tests

Install dependencies:
```bash
pip install websockets aiohttp msgpack
```

Run a NanoVer python server as usual (e.g with nanover-omni or a jupyter notebook).

Run the websocket converter:
```bash
cd tools
python wss-server.py
```
