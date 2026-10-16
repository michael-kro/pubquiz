# Running the quiz from a travel router

**Status: written from the design notes and OpenWrt/GL.iNet documentation, not yet tried on a real router.** The app side (the Wi-Fi QR code, `--lan`, `--public-host`) is built and tested. The router steps below are the standard way to do it; expect to adjust screens and menu names for your model and firmware, and try the whole thing at home before a quiz night.

## Why

A small router (a GL.iNet Beryl AX is the one the design notes recommend, about £80–£90; a cheaper travel router works for a smaller crowd) gives you your own quiz Wi-Fi, so:

- the quiz never depends on the venue's Wi-Fi, its login page, or whether the venue has internet at all;
- phones talk to the laptop over one short, quiet network, so answer timing is tight and even;
- "client isolation" on the venue's guest Wi-Fi stops being your problem.

Teams who want their own internet can use mobile data; if you plug the router into the venue's Ethernet, they can have internet on the quiz Wi-Fi too.

## What you need

- The router and its power (a USB-C power bank works if there's no spare socket).
- The laptop running the quiz.
- Optional: an Ethernet cable from the venue's router to the travel router's WAN port, if you want to share internet.

## Setup (do this once, at home)

1. **Start the router fresh** and open its admin page (for GL.iNet, `192.168.8.1`). Set an admin password.
2. **Name the Wi-Fi.** Set the network name (SSID) to something short, such as `QuizNight`, and a password you don't mind showing on the TV, or leave it open. Prefer 5 GHz for phones, keep 2.4 GHz on for older ones.
3. **Turn client isolation off** for that Wi-Fi (sometimes called "AP isolation" or "guest network isolation"). Phones must be able to reach the laptop. This is the single most common reason a quiz page won't load.
4. **Give the laptop a fixed address.** In the router's DHCP settings, reserve one address for the laptop's Wi-Fi/Ethernet adapter (for example `192.168.8.50`), so it doesn't change between nights.
5. **Optional: a friendly name.** In the router's DNS or hostnames settings, point `quiz.lan` at the laptop's reserved address. Avoid names ending in `.local`, which phones look up differently and often fail.

## On the night

1. Plug the router in. Join the laptop to its Wi-Fi (or cable it to a LAN port).
2. Start the quiz in local mode, telling it the router's Wi-Fi so the screens can show a QR code for it:

   ```sh
   npm start -- --lan \
     --public-host quiz.lan --port 80 \
     --wifi-ssid QuizNight --wifi-password beer1234
   ```

   - `--lan` skips the internet link (it's not needed).
   - `--public-host quiz.lan` (or the laptop's reserved address, e.g. `192.168.8.50`) puts the right address in the join QR code. Without it the program guesses, and a laptop with several networks can guess wrong.
   - `--port 80` lets teams type `quiz.lan` with no port. Binding port 80 can need extra permission on some systems; if it fails, leave it off and the address becomes `quiz.lan:3000`.
   - `--wifi-ssid` and `--wifi-password` add a second QR code to the host and TV lobby: **1. Join the Wi-Fi**, **2. Open the quiz**. Leave the password out for an open network.
3. Put the TV screen link (**TV screen ↗**) on the projector. Teams scan the first code to join `QuizNight`, then the second to open the quiz. On many phones the first scan joins the Wi-Fi in one tap.

## If it doesn't work

| Symptom | Likely cause |
|---|---|
| The quiz page won't load after joining `QuizNight` | Client isolation is still on, or the join QR points at the wrong address. Check `--public-host`, and that the laptop's address matches the router's reservation |
| "This site can't be reached" for `quiz.lan` only | The DNS entry is missing or wrong. Use the laptop's address instead |
| Phones keep jumping back to mobile data | The router has no internet, so some phones decide the Wi-Fi is broken. Turn off "Wi-Fi assist"/"smart network switch", or plug in the venue's Ethernet |
| Teams drop out mid-round | Too many phones for one radio, or a weak position. Put the router high and central, on 5 GHz, and keep to the 30-team limit |
| The laptop's address changed | The DHCP reservation wasn't saved; set it again |

More venue tips are in [VENUE-TROUBLESHOOTING.md](VENUE-TROUBLESHOOTING.md).

## What isn't here yet

Running the quiz **on the router itself**, so no laptop is needed, is a later step (M7b and M7c in [PLAN.md](../PLAN.md)). It needs the hardware to test, and the plan recommends trying Node on the router before considering a rewrite in Go. A captive portal (so the join page pops up by itself when a phone joins the Wi-Fi) and a firewall switch that blocks the internet during questions are also router-side jobs, listed in the plan.
