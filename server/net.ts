import { networkInterfaces } from 'node:os';

/** What a phone's camera app reads to join a Wi-Fi network: WIFI:T:WPA;S:name;P:password;; (with ; , : \\ " escaped). */
export function wifiQrText(ssid: string, password?: string): string {
  const escape = (text: string) => text.replace(/([\\;,:"])/g, '\\$1');
  return password ? `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;` : `WIFI:T:nopass;S:${escape(ssid)};;`;
}

const PRIVATE_RANGE = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
const WIFI_OR_ETHERNET = /^(en|wl|eth|Wi-Fi|Ethernet)/i;
const VIRTUAL = /^(utun|tun|tap|docker|br-|veth|vbox|vmnet|bridge|lo)/i;

/** Best guess at the address phones on the same network can reach this laptop on. */
export function lanAddress(): string | undefined {
  const candidates: { name: string; address: string; score: number }[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const score =
        (PRIVATE_RANGE.test(a.address) ? 2 : 0) + (WIFI_OR_ETHERNET.test(name) ? 1 : 0) - (VIRTUAL.test(name) ? 3 : 0);
      candidates.push({ name, address: a.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address;
}
