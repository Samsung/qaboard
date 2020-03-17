# Contributing to QA-Board
👍🎉 First off, thanks for taking the time to contribute! 🎉👍

The following is a set of guidelines for contributing to QA-Board. These are mostly guidelines, not rules. Use your best judgment, and feel free to propose changes to this document in a pull request.

## Code of Conduct
This project and everyone participating in it is governed by the QA-Board [Code of Conduct](https://github.com/Samsung/qaboard/blob/master/CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to arthur.flam@samsung.com.

## Questions?
If you've got questions about anything (setup, contributing...) or just want to chat with the developers, please feel free to [start a thread in our Spectrum community](https://spectrum.chat/qaboard)! You can also contact us [by mail](arthur.flam@samsung.com).

## Code organization
Each section has its own README:
- [qaboard](qaboard): provides the `qa` CLI wrapper than runs your code, and the associated package (`import qaboard`).
- [webapp](webapp/) is the frontend that displays results.
- [backend](backend/) exposes an HTTP API used to read/write all the metadata on runs.
- [website](website/) is the QA-Board website and docs - samsung.github.io/qaboard
- [thirdparty](thirdparty/):
  * [Cantaloupe](https://medusa-project.github.io/cantaloupe/) IIIF server, used to "stream" large images to the users.

## Where to start
If you want to contribute to the project but do not know where to start, or what to work on, don't hesitate to chat with the maintainers. QA-Board has many parts and much can be improved. We'll do our best to find something that matches your experience and has a meaningful impact on the project. Before you work on a big feature, don't hesitate to open an issue and discuss it.


## Openness
Currently, we use internally at Samsung a private fork of QA-Board. The differences are very small, mainly having to do with hardcoded configuration and CI. Our goal to move to a process where we first contribute to the public repository, then merge back the changes.

We want to develop QA-Board in the open, and started asking our users to submit issues on GitHub.com. We plan on using the public issue tracker to discuss the roadmap.