# FitCalorie

A personal calorie and nutrient log. Barcodes are resolved through Open Food Facts. Product links are read for a nutrition table or structured data. An optional AI extractor is used only when a page has neither, and only numbers that appear in the page are kept.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://127.0.0.1:8787.

On an iPhone, join the same Wi-Fi and run `npm run dev`. Vite prints a Network address such as `http://192.168.1.20:5173`. Open that address in Safari, then use Share → Add to Home Screen. The live barcode camera needs an https address, so on this local address use Take a barcode photo. The hosted trial link is https and can use the live camera. If Safari cannot connect, allow incoming connections for Node in the Mac firewall.

To serve the built app from one process:

```bash
npm run build
npm start
```

## Configuration

Copy `.env.example` to `.env`.

- `OPENAI_API_KEY` is optional and stays on the server. Without it, barcodes and nutrition tables still work. Pages with no nutrition table return a clear error instead of guessed values.
- `OPENAI_BASE_URL` and `OPENAI_MODEL` select an OpenAI-compatible chat endpoint.
- Food entries are stored in SQLite at `data/fitcalorie.sqlite`.

## Share a trial

The app on this computer is only reachable at localhost. A friend needs a public HTTPS address so the site, including the barcode camera, works on their phone, and the SQLite file has to live on a disk that survives restarts.

[Fly.io](https://fly.io) can host that for the trial. In Ashburn, a 512 MB machine left running is about $3.69 per 30 days, and a 1 GB disk is $0.15. Three weeks is a few dollars. The friend’s log stays on that disk. This computer’s `data/` folder is not uploaded.

```bash
brew install flyctl
fly auth signup
fly deploy
```

`fly deploy` prints an `https://fitcalorie-trial.fly.dev` address. Open it, then send that address to your friend so they can create their own account. If that app name is taken, change `app` in `fly.toml` and run `fly deploy` again.

Barcode lookup still uses Open Food Facts. Pages that have no nutrition table need an `OPENAI_API_KEY`, which you can set with `fly secrets set OPENAI_API_KEY=...` before deploying. Each account can also save its own key in the app.

When the trial is over, `fly apps destroy fitcalorie-trial` stops the billing and deletes the hosted log.

## Tests

```bash
npm test
npm run test:e2e
```

The end-to-end test calls Open Food Facts and a real product page. It also points the AI client at a local OpenAI-compatible stub because no production key is configured.
