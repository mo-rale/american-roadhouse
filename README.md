# American Roadhouse Hotel & Restaurant

Responsive static website for American Roadhouse in Guindulman, Bohol. It uses HTML, CSS, and vanilla JavaScript; there is no build step or package installation.

## Pages

- `index.html` — home and quick booking inquiry
- `rooms.html` — room types and rates
- `restaurant.html` and `menu.html` — dining and menu
- `gallery.html` — photo gallery and lightbox
- `about.html` and `location.html` — business information and directions
- `contact.html` — room, table, and general inquiry forms
- `booking.html` — standalone booking inquiry page
- `order.html` — online food ordering (Supabase)
- `<random-name>.html` — staff dashboard: live orders, menu, prices, audit trail (Supabase auth, noindex)

## Main files

- `assets/css/style.css` — current design system and responsive styles
- `assets/js/main.js` — navigation, gallery, form validation, and Web3Forms submission
- `assets/js/data.js` — legacy content data; the current pages render their content directly in HTML
- `style.css` and `main.js` at the project root — legacy copies; current pages load the files under `assets/`

## Online ordering

Backed by Supabase; see [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) for the schema (`supabase/`), auth, roles, RLS, env vars (`.env` → `node scripts/build-env.mjs`) and local testing. The service-role key must never be used in the frontend.

## Run locally

From this folder (the one containing `package.json`, not its parent):

```sh
npm start
```

Then open http://localhost:8080 (ordering page: `/order.html`). It is a dependency-free static server with caching turned off, so edits show on a normal reload. Use `PORT=3000 npm start` for another port.

The online ordering and the staff dashboard need your Supabase settings: copy `.env.example` to `.env`, fill it in, and `npm start` will generate `assets/js/env.js` for you (or run `npm run build`). See `docs/SUPABASE_SETUP.md`.

## Before publishing

- The sitemap, crawler directive, canonical URLs, and Open Graph URLs currently target `https://moralportfolio.crapeling29.workers.dev`. Update them together if the production domain changes.
- Confirm room names, rates, included services, taxes, menu details, operating hours, and all business claims with the owner.
- Confirm the Web3Forms access key is enabled for the production domain and that messages reach the intended inbox. Inquiry forms send names, contact details, and booking or message details to that service.
- Publish a privacy notice explaining what information the forms collect and how inquiries are handled.
- Replace duplicate, oversized images with optimized variants for faster mobile loading.

The booking form collects inquiry details; it does not check live room availability or confirm a reservation automatically.
