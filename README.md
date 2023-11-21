## Description

CS2HUE enables Counter-Strike players to synchronize Philips Hue lights with the game, enhancing immersion by dynamically controlling the lights based on the in-game state.

## Features

- **Player’s team lightning** : your light will display your team’s color (CT, T) while you’re in a game.
- **Bomb lightning** : your light start to blink as soon as the bomb is planted, increasing in speed until the bomb explode, or is defused.

<aside>
ℹ️ This beta version might face some light bugs that will have no incidence on your game. Feel free to share your issues on this reddit thread in order to help me fix them. This script is constantly improved!

</aside>

## Installation

1. Clone the repository or download the script files.

```bash
git clone https://github.com/floranknz/CS2HUE.git
```

2. Copy the `gamestate_integration_cs2hue.cfg` file to your CS2 config directory :

```text
C:\Program Files\Steam\steamapps\common\Counter-Strike Global Offensive\csgo\cfg
```

3. Install [Node.js](https://nodejs.org/en)

4. Open config.json and edit the required informations. Check tutorial below on how to find everything.

```jsx
{
    "BRIDGE_IP": "192.168.1.10",       // The IP address of your Hue bridge
    "API_KEY": "YOUR_API_KEY_HERE",    // The API key to access your Hue bridge
    "LIGHT_ID": 0                      // The ID of the light you want to react to your game
}
```


## Usage

1. Open terminal from the script folder and run `node server.js`
2. Open another terminal and run `node hue.js`
   

## Tutorial : how to get the informations?

### Hue bridge IP

To get your the IP of your Bridge, click on [this link](https://discovery.meethue.com/) (you need to be on the same network as the bridge)

### API key

- To generate a new API key, you’ll need to go to the Debug tool, through this address (replace informations) : `http://YOUR_BRIDGE_API/debug/clip.html`
- In the URL field, enter `/api`
- In the message field, enter `{"devicetype":"CS2HUE#device"}`
- Before clicking on `POST`, you need to press the button on your Hue bridge
- You will get a response from your hue bridge containing your API key inside `username`.
- Copy paste this information into `config.json`

### Light ID

To make this script work, you need to define which light you want to animate.

- Open the Debug tool though on `http://YOUR_BRIDGE_API/debug/clip.html`
- Fill the URL field with `/api/YOUR_API_KEY/lights` (replace informations)
- Press `GET` button
- In the response area, you’ll get a list of all the lights of your bridge. Press `CTRL+F` and search for the name of the light you want to control
- Once you find it, go a bit upper until you find a number, just before “`state`"
- Use this number in `config.json`
