# Meeting Copilot

A single-page live call coach. It listens to your microphone and your computer's audio, transcribes both with ElevenLabs realtime speech-to-text, and shows short SAY / ASK / HEADS-UP prompts while the other person talks.

Nothing personal is stored in this repo. Your keys and meeting notes stay in your own browser.

## Two ways to run it

**On your Claude subscription (no Anthropic API key)**

Needs Node.js 18+ and Claude Code installed and logged in (`claude`, then `/login`).

    git clone <this repo> && cd <folder>
    node copilot-server.js        # Windows: double-click start-copilot.bat

It opens `http://localhost:8765`. Leave the helper window open during the call.

**Hosted page**

Open the GitHub Pages copy of `index.html`. If the helper above is running on the same computer the page finds it and uses your subscription; otherwise it asks for an Anthropic API key.

## Setup in the page

1. Paste your ElevenLabs API key.
2. Load your notes file, or type your meeting notes and the points you want to raise.
3. Press **Test keys**, then **Start listening** and share your screen or tab with audio ticked.

A notes file is plain text. Optional first lines `ME: name` and `THEM: name`, then your notes, then a line `===POINTS===` followed by one point per line.

Use Chrome or Edge.
