# Venue troubleshooting

## Teams can't open the join link

| What you see | Likely cause | What to do |
|---|---|---|
| The QR code scans but the page never loads, and the host screen says **📶 Local Wi-Fi** | You're in local Wi-Fi mode and the phones aren't on the laptop's Wi-Fi, or the venue Wi-Fi stops devices talking to each other ("client isolation", common on guest Wi-Fi) | Press **Use the internet link** on the host screen (if the laptop has internet), or start the program without `--lan` |
| The host screen says **🌐 Connecting to the internet…** for a long time | The laptop has no internet, or the venue blocks the connection | Check the laptop can open a web page. Otherwise see "No internet at the venue" below |
| **⚠️ Internet link down** banner | The link dropped | The program retries by itself. If it keeps failing, press **Switch to local Wi-Fi** |
| The page loads, then says "Reconnecting…" | The phone lost signal or went to sleep | It rejoins by itself when the screen is on. Teams don't lose their score |
| A team closed the page and lost its place | | Scan the QR code again, tap **Already joined? Rejoin with your team code**, and type the 6-character code from their old screen (or ask the quiz master) |

After the internet link drops and comes back, it has a **new address**, so the old QR code stops working. Teams that were already playing rejoin on their own; a team that wants to join later scans the new QR code.

## No internet at the venue

The quiz doesn't need the internet itself, only a network the phones and the laptop share. Run `pubquiz --lan` (or press **Switch to local Wi-Fi**), then pick one:

1. **A small travel router** (about £20–£30, plugged into power) that makes its own Wi-Fi. Join the laptop to it and put the teams' phones on it too. This is the most reliable option, and it works with no venue network at all. Make sure client isolation ("AP isolation") is **off**. With the router's name for the laptop (or its address) set as `--public-host`, the QR code points at the right place. See [ROUTER-SETUP.md](ROUTER-SETUP.md) for a step-by-step guide, including a second QR code for joining the router's Wi-Fi. The router-box plan in `PLAN.md` goes further: the router becomes the whole product.
2. **Your phone's hotspot.** Join the laptop and the teams' phones to it. Try this before the night: some phones' hotspots won't let devices see each other, and most only allow a handful of devices.
3. **The venue's own Wi-Fi**, if it lets devices see each other (many pubs' guest Wi-Fi does not).

In local mode, the join link uses the laptop's address on that network. If the QR code shows the wrong address (a laptop with several networks), start with `--public-host <the laptop's address on the quiz Wi-Fi>`.

Phones that are on the quiz Wi-Fi may lose their own internet, which some teams dislike. They can use mobile data for the rest of the night; the quiz is local.

## Too many phones on one Wi-Fi

Plan for up to 30 teams, one phone per team. If answers arrive late or teams drop, ask players not to use the quiz Wi-Fi for anything else, and use 5 GHz if you control the router. With the internet link, teams can use mobile data instead and the venue Wi-Fi doesn't matter.

## Pictures load slowly

Pictures you upload in the editor are shrunk for you. Pictures you reference by hand in a quiz file are used as they are (up to 10 MB each), so shrink big photos first. The next question's picture is loaded onto phones before the question opens.

## Teams say the timer is unfair

The server measures each team's connection delay and takes it off, and phones time their own answers, so a slow connection isn't penalised (up to 1.5 seconds). The host's **Pause** stops the clock for everyone.

## The laptop sleeps or the program closes

Turn off sleep for the night. If it closes, run the program again and **Resume** the quiz. Phones rejoin on their own.

## Starting fresh

`pubquiz <quiz file> --fresh`, or **Start over** next to an unfinished quiz in your library.
