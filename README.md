# novpn

A self-hosted "is this IP a VPN?" lookup service. Pulls VPN exit-IP lists from
public sources, normalizes them into a SQLite-flavored database, and answers
point-in-CIDR queries over a small HTTP API. Optional opt-in for non-VPN
categories like AbuseIPDB.
