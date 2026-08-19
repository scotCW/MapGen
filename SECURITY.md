# Security Policy

## Supported Versions

This project is in initial prerelease (`0.0.x`). Only the latest `master` / most recent release is supported with security fixes.

## Reporting a Vulnerability

**Low-severity issues** (e.g. non-exploitable misconfigurations, hardening suggestions, issues requiring unusual local access): please [open a GitHub issue](https://github.com/scotCW/MapGen/issues/new) directly. No need to email for these.

**Higher-severity issues** (anything plausibly exploitable, or involving user data): email **299917302+scotCW@users.noreply.github.com** instead of opening a public issue. Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The affected version/commit

You should expect an initial response within a few days. Once a fix is available, we'll coordinate on disclosure timing before any public writeup.

## Scope

This repo ships two independent app shells (Tauri and Swift — see [README](README.md)) around a shared frontend. Reports are welcome for either, or for the shared frontend/data-handling code in `src/`.
