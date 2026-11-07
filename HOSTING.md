# Hosting a game of Poker with Friends (Windows)

One person hosts. Everyone else only needs a browser, on a PC or a phone.

## 1. Start the server

You need [Node.js](https://nodejs.org/) 20 or newer. In the project folder, open a terminal and run:

```
npm install
npm start
```

`npm start` builds the page and starts the server on port 3001 (not 3000, so Blackjack with Friends can run on the same PC at the same time). After a few seconds you will see something like:

```
Host link (opens host controls, keep it to yourself):
  http://localhost:3001/?host=Zx3k...

Share one of these with players on your network:
  http://192.168.1.42:3001
```

- Your browser opens the **host link** by itself. That link gives you the host controls (settings, Start, kick). **Do not share it.** If you close the tab, open the same link again to get the controls back.
- Send players one of the other addresses. They paste it into their browser, type a username, and join.
- To use another port: in PowerShell `$env:PORT=3002; npm start`, in Command Prompt `set PORT=3002 && npm start`.
- To stop the game, press `Ctrl+C` in the terminal or close its window. That ends the game for everyone.

Chips are saved per username in `data\players.json`. Delete that file to give everybody fresh chips.

## 2. Pick how players reach you

| Option | When it works | Setup |
| --- | --- | --- |
| Same Wi-Fi or LAN | Everyone is on the same network | See below |
| Port forwarding | Over the internet | See below |
| Tailscale | Over the internet, no router changes | See below |
| Tunnel (cloudflared) | Over the internet, nothing for players to install | See below |

### Same Wi-Fi or LAN

1. The server prints your LAN addresses when it starts. To find the address yourself, open a terminal and run `ipconfig`. Look for **IPv4 Address** under your active adapter (Wi-Fi or Ethernet), for example `192.168.1.42`.
2. Players open `http://192.168.1.42:3001` (your address, then `:3001`).
3. The first time, Windows Firewall asks whether to let Node.js through. Tick **Private networks** and click **Allow access**. If you missed the prompt:
   - Open **Windows Security > Firewall & network protection > Allow an app through firewall**.
   - Click **Change settings**, find **Node.js JavaScript Runtime**, and tick **Private**.
   - If it is not in the list, click **Allow another app** and add `node.exe`.
4. If a player still cannot connect, check that they are on the same Wi-Fi (some guest networks and public Wi-Fi block devices from talking to each other) and that your network is set to **Private** (Settings > Network & Internet > Wi-Fi > your network > Network profile).

### Port forwarding (over the internet)

1. Give your PC a fixed LAN address (or a DHCP reservation in your router) so the forward keeps pointing at it.
2. In your router's settings, forward **TCP port 3001** to your PC's LAN address, port 3001. Every router words this differently; look for "Port forwarding" or "Virtual server".
3. Click **Share** in the waiting room. The server looks up your public IP (it asks api.ipify.org), shows `http://YOUR_PUBLIC_IP:3001` and copies it to your clipboard. Send that link to players. (You can also search "what is my IP" and build the link yourself.) The link does not give host controls. If your router forwards a different outside port, change the port in the link.
4. Allow Node.js through the firewall for **Public networks** too, if your PC treats the network as public.

Everything is sent unencrypted over plain `http`, and anyone who learns your address can try to join. Set a **table password** in the waiting room, and stop the server when you are done.

### Tailscale (over the internet, no router changes)

1. Everyone, you included, installs [Tailscale](https://tailscale.com/download) and signs in.
2. Share your tailnet with your friends (in the Tailscale admin page, invite them or share your PC with them).
3. Find your Tailscale IP in the Tailscale app, or run `tailscale ip -4`. It looks like `100.x.y.z`.
4. Players open `http://100.x.y.z:3001`.

### Tunnel with cloudflared (nothing for players to install)

1. Install `cloudflared` ([download page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or `winget install Cloudflare.cloudflared`).
2. Start the game with `npm start` as usual, then in a second terminal run:

   ```
   cloudflared tunnel --url http://localhost:3001
   ```

3. It prints a public `https://something.trycloudflare.com` link. Share that link with players. The page works over `https`, and the game connects with `wss` automatically.
4. Keep both terminals open while you play. Use your **host link** (the `localhost` one) for the host controls. Do not open the host link through the tunnel address, and do not share it.

## 3. Running a game

1. Open the host link. Enter a username and click **Join**.
2. In the waiting room, change the settings if you want (max players, table password, starting chips, small and big blind, turn timer). Players see them but cannot change them.
3. When at least two players are ready, click **Start game**. Settings are locked from then on, until the server restarts.
4. Players who join later go straight to the table and take a free seat and are dealt in from the next hand. If every seat is full they watch until one frees up.
5. A new hand starts by itself after each one, as long as at least two seated players have chips and are not sitting out.
6. You can kick a player with the button on their seat. A kicked player cannot rejoin with that name until the server restarts.

## Troubleshooting

- **"Port 3001 is already in use"**: another program is using it. Close it, or start with a different port (see above).
- **Players see "Connection lost"**: the server stopped or their network dropped. Chips are kept up to the last finished hand. Click **Retry**.
- **Refreshing the page**: a player who refreshes within 20 seconds gets the same seat and the same cards back.
- **`data\players.json` got damaged**: the server renames it to `players.json.bak`, prints a warning and starts with no saved players.
- **The browser did not open**: copy the host link from the terminal into your browser. Setting the environment variable `NO_OPEN=1` turns off the automatic opening.
