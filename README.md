# TimeBox Evo for Homey

**The pixel heart of your smart home.**

TimeBox Evo turns your Divoom TimeBox Evo pixel display into the friendly screen of your
[Homey](https://homey.app). Homey talks to it directly over Bluetooth and keeps its clock right. Show the time and the
weather in the morning, let a scrolling note tell you that the washing machine is done or that someone rang the doorbell,
start a pizza countdown in the kitchen, or put a snapshot of your doorbell camera on the 16x16 display.

## What you can do

- Pick a mode on the device tile: clock, lighting or your own custom pages.
- Show the clock in several styles and colours, with optional weather, temperature and calendar pages.
- Switch the display on and off, set its brightness and its colour on the device tile; use it as mood lighting in any colour.
- Show a scrolling text from a Flow (and stop it again).
- Show a temperature and a weather type, set by hand in a Flow or automatically from Open-Meteo.
- Start and stop a countdown, and start a Flow when it ends ("Countdown ended" trigger).
- Show an image from an image tag (for example a camera snapshot) or from a URL, scaled to 16x16.
- React to the display being connected or disconnected (triggers and a condition).
- Automatic time sync with the time of your Homey.

## Requirements

- A Homey Pro with Bluetooth (the app runs locally on the Homey, Homey firmware 12.0.0 or newer).
- A Divoom TimeBox Evo within Bluetooth range of the Homey.
- The Divoom phone app must not be connected to the TimeBox: it accepts only one Bluetooth connection at a time.

TimeBox Evo for Homey is an independent community app and is not affiliated with or endorsed by Divoom.

## Development

A [Homey](https://homey.app) app that integrates the **Divoom TimeBox Evo** pixel display
(Bluetooth) into Homey: clock, lighting, custom pages, scrolling text, weather, countdown and images from the device tile and Flows.

> Status: rebuild in progress (see [`docs/roadmap.md`](docs/roadmap.md)). Milestone 0.2.0 (core) is implemented:
> BLE pairing, a `dim` capability, availability, automatic time sync and the Flow cards "TimeBox is connected",
> "TimeBox connected/disconnected".
> Implemented for 0.5.0 (Images, #31 done; #101 "Countdown ended" Flow trigger done; accepted 2026-10-08): the Flow actions "Show image" (image tag) and "Show image from URL" (PNG, JPEG, GIF scaled to 16x16, optional duration) and the device trigger "Countdown ended".
> Implemented for 0.4.0 (Text, weather & countdown, accepted 2026-10-07): the Flow actions "Show text" / "Stop text" (native scrolling text),
> "Set temperature" and "Set weather" (plus optional automatic weather from Open-Meteo in the device settings) and "Start countdown" / "Stop countdown".
> Implemented for 0.3.0 (Display & modes, accepted 2026-10-07): a mode picker (clock, lighting, custom) with Flow cards, the clock face (style, weather, temperature
> and calendar pages in the device settings, Flow action "Show clock"; the clock colour follows the tile colour picker) and power and mood lighting (on/off on the
> tile, one colour picker for the active mode, Flow action "Set lighting" with a colour), plus the Flow action "Show custom page" (1-3). Cloud, visualizations and the scoreboard are not offered; if the device shows cloud or a visualizer, the mode tile is empty.
>
> **Turn everything off:** the TimeBox has an `onoff` capability, so any Homey action that sets it is expected to turn the
> panel off: the tile, the Flow card "Turn off", and zone-wide or voice actions that address `onoff`. "All lights off" that
> addresses light devices should not include it (the device class is `other`, not `light`). Turning it on returns to the last mode
> (clock, lighting or custom). Changing the brightness (`dim`) of a switched-off TimeBox does not
> light the panel: the app holds the value and sends it when the panel is switched on again (#62).
> Current version: 1.1.0 (milestone Bugfix after Release 1.0, accepted 2026-10-18). Changelog: `.homeychangelog.json`.

This repository is developed by **autonomous local Claude Code agents** (plan → implement → docs → review →
hardware test on the real Homey with a webcam → merge), started with `/autopilot` or `/implement <issue>`.
GitHub only manages the work (issues, PRs); the knowledge lives in this repo. The owner is asked via ntfy when needed.

- Start here for agents and humans: [`CLAUDE.md`](CLAUDE.md)
- Documentation / knowledge base: [`docs/`](docs/README.md)
- How the agent workflow works: [`docs/pipeline.md`](docs/pipeline.md)
