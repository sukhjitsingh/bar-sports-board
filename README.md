# Daily Sports Schedule

A single-page, mobile-friendly daily schedule for the NFL, college football (FBS), MLB, NBA, NHL, and college basketball (Division I). Pick a day, toggle leagues, or filter by team. Times display in Arizona time (America/Phoenix, no daylight saving).

The pages are static. A GitHub Action refreshes `data.js` every day at 8:00 AM Arizona time from ESPN's public scoreboard endpoints and commits it to `main`, and GitHub Pages serves the result. The TV page also pulls live scores straight from ESPN while it is open.

```
index.html                       phone-friendly daily tracker
tv.html                          1080p TV board (3 layouts, live scores, auto-refresh)
data.js                          schedule data (rewritten by the workflow)
scripts/update-data.mjs          fetches ESPN data, writes data.js (Node 18+, no dependencies)
scripts/build-preview.mjs        builds a one-file preview of tv.html with sample scores
.github/workflows/update-data.yml   daily at 8 AM Arizona + manual trigger
.nojekyll                        tells Pages to serve files as-is
```

## Set up

1. Create a repository and push everything to `main`:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: daily sports schedule"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
2. **Settings → Pages**: Source = *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions**: choose *Read and write permissions* (only needed if your account or org defaults to read-only).
4. Test the workflow: **Actions → Update schedule data → Run workflow**. When it finishes, `data.js` gets a new commit and the site rebuilds within a minute or two.

The workflow runs daily at 15:00 UTC, which is 8:00 AM Arizona time (GitHub cron uses UTC and may start a few minutes late). To change that, edit the `cron` line in `.github/workflows/update-data.yml`.

## TV board

Open `https://<your-username>.github.io/<repo-name>/tv.html` in the TV's browser (or cast the tab). It is built for 1920x1080 and scales to any screen.

- **Picking a layout:** move the mouse, tap the screen or press any key on the remote or keyboard, and a picker appears at the bottom with all three layouts. Pick one and it hides again after 6 seconds. The choice is remembered on that TV.
- **Layouts:** `tv.html#today` (all of today's games, big), `tv.html#league` (one league at a time, rotating), `tv.html#split` (live games on the left, up next on the right). The page remembers the last layout it showed. Keys 1, 2 and 3 switch layouts, arrow keys flip pages, F goes fullscreen, D toggles sample scores (for testing).
- **Live scores:** while open, the page asks ESPN for today's scoreboard every 60 seconds when a game is live or about to start, and every 5 minutes otherwise. It also fills in TV channels and any games missing from `data.js`. If ESPN can't be reached, the footer says "Schedule as of ..." and the page keeps showing `data.js`.
- **Schedule refresh:** it re-downloads `data.js` every 15 minutes and reloads itself every 6 hours, so nobody has to touch the TV.
- **Preview without GitHub:** `node scripts/build-preview.mjs` writes `tv-preview.html` with data inlined and sample scores on.

## What each run does

- Works out today's date in Arizona time (not UTC), then covers yesterday through 13 days ahead, so Sunday's results and the next two weeks show up.
- Asks ESPN for **one day at a time** per league (about 17 requests per league, including a one-day buffer on each end for late-night games). ESPN stopped reliably accepting date ranges, and per-day requests also avoid truncated results on busy college basketball days.
- Records the ESPN event ID, start time, scores for finished or in-progress games, TV channel, the betting line for upcoming games, and headline notes (playoff round, etc.).
- If some days fail for a league, it keeps that league's earlier games for the gaps, but only ones still inside the current window, so old games never linger. The footer on the page then says which leagues could not be fully refreshed and when they last were. The run also posts a warning annotation in the Actions log.
- If no league loads completely, the run fails, `data.js` is left alone, and GitHub emails you.
- Commits only when something changed, straight to `main`.

Run it locally any time: `node scripts/update-data.mjs`

## Things to know

- **`index.html` scores are as of the last run** (up to a day old). Only the TV board polls ESPN live. If you want the phone page live too, say so and the same polling can be added.
- **ESPN from the browser:** the TV page calls ESPN directly. That works only if ESPN allows cross-origin requests from github.io, which could not be tested from the build environment. Check the footer pill: green "Live scores" means it works.
- **The data source is unofficial.** ESPN's endpoints are public but undocumented and can change without notice. If a league stops updating, check the Actions log first. The parsing lives in `parseEvent()` and the request logic in `fetchDay()` in `scripts/update-data.mjs`.
- **Win probabilities aren't in this feed.** The earlier snapshot had them (`pa` / `ph` fields); the workflow shows the betting line instead. The page still displays `pa` / `ph` if you add them by hand.
- **Opening `index.html` from disk works**, because data loads through a normal `<script>` tag rather than `fetch`.
- **Branch protection:** if `main` is protected, the bot's direct push will be rejected. Allow `github-actions[bot]` to bypass, or the workflow will fail at the commit step.
- **Inactive repos:** GitHub can pause scheduled workflows in public repos after about 60 days without repo activity. The 6-hourly data commit should count, but if runs ever stop, re-enable the workflow in the Actions tab.
- **Time zone:** change the `TZ` constant near the top of the script in `index.html`. The `-07:00` used to build the day labels is Arizona's, so adjust that too if you change zones.
