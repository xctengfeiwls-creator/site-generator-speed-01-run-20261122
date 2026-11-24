# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/xctengfeiwls-creator/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/xctengfeiwls-creator/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast static site generator: the same answers as makefun-site 1.0.0, built for CPU time. It reads every case from `/input/cases.json`, builds each site (front matter, Markdown subset, template dialect, slugs, tags, index and tag pages, build report) and writes `/output/answers.json`. Speed comes from bulk HTML escaping, a regex-scanned inline renderer, memoized slugs, a single-join Markdown output and cached reading times — no dependencies, no clock, no randomness, no model calls.

## Run it

```sh
MAKEFUN_INPUT_DIR=/tmp/in MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## Size

- `solve.js`: the generator (dependency-free ES module, `run(input)` returns one site's output tree)
- `main.ts`: the driver (reads `/input/cases.json`, writes `/output/answers.json`)

---

<sub>Entered on [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
