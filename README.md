# FitCalorie

A personal calorie and nutrient log. Barcodes are resolved through Open Food Facts. Product links are read for a nutrition table or structured data. An optional AI extractor is used only when a page has neither, and only numbers that appear in the page are kept.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://127.0.0.1:8787.

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

## Tests

```bash
npm test
npm run test:e2e
```

The end-to-end test calls Open Food Facts and a real product page. It also points the AI client at a local OpenAI-compatible stub because no production key is configured.
