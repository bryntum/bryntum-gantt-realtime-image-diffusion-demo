# Bryntum Gantt with realtime image diffusion demo

An app that lets you style a [Bryntum Gantt](https://bryntum.com/products/gantt/) in realtime using a prompt. Uses [Fal](https://fal.ai/) and the [FLUX.2&#91;klein&#93; model](https://bfl.ai/models/flux-2-klein). 

## Install dependencies

Run the following command to install the project dependencies:

```bash
npm install
```

## Get a Fal token

Sign up to [Fal](https://fal.ai/), the generative AI platform. Complete signup and you'll land in the [dashboard](https://fal.ai/dashboard).

Go to https://fal.ai/dashboard/keys then click **Add key**, give it a name , and create it. Copy the key immediately as it's only shown once.

## Add the key to the demo app

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Open `.env` and add your key:

```
FAL_KEY=your-actual-key-here
```

## Run the development server

Run the Vite development server:

```bash
npm run dev
```

The server will start on `http://localhost:5173`. The HTML-in-Canvas API that this demo uses needs Chrome Canary version 149+ or Brave Stable. You also need to enable `chrome://flags/#canvas-draw-element` and `chrome://flags/#enable-experimental-web-platform-features` from the URL input, then relaunch the browser.