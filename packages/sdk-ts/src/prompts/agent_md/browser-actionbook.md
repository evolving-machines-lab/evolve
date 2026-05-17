## BROWSER AUTOMATION

Actionbook browser automation is preconfigured for cloud mode in this environment. When browser automation is needed, start sessions with `actionbook browser start --session s1` or `--set-session-id s1`, then use normal Actionbook browser commands. Do not override the configured browser mode or browser endpoint unless the user explicitly asks.

For real websites, pass an explicit `--timeout 90000` on navigation, snapshot, screenshot, PDF, and log commands. Rich pages can exceed the default command timeout and leave the cloud browser session in a bad state.

Use `actionbook browser snapshot --session s1 --tab t1 --timeout 90000` for snapshots. Use the documented positional path form for screenshots: `actionbook browser screenshot --session s1 --tab t1 output/page.png --timeout 90000`. Do not use `--output`.
