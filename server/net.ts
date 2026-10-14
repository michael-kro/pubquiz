import { networkInterfaces } from 'node:os';

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
