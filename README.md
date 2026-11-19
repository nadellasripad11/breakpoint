# breakpoint

plan for the what if. landing page for breakpoint, a schedule stress-tester.

front end only for now: vite + vanilla js, gsap (scrolltrigger, splittext, drawsvg) and lenis for smooth scroll.

```
npm install
npm run dev      # http://localhost:5173  (add ?static to skip animations)
npm run build    # -> dist/
npm test         # frontend unit tests
```

## backend

the scheduling engine and api live in [`server/`](server/README.md): deterministic engine (chaos engine, butterfly effect, breaking point, parallel futures, fortify), google sign-in, guest demo, read-only calendar imports. run it with `cd server && npm install && npm start`; client + integration guide in `server/docs/FRONTEND.md`.

the onboarding connectors (google calendar, notion, .ics) are wired to it. try them with no credentials: `cd server && npm run sim`, then `npm run dev` here. real credentials and hosting: `server/docs/SETUP-CONNECTORS.md`. a production build only talks to the api when `VITE_API_URL` is set at build time.

## layout units

on desktop `1rem = 100px` of the 1672px mockups, so the page scales exactly with the viewport. below 1024px it switches to a stacked layout.

## art

the capybara + rock scenery is cropped from the mockups in `art/` by `node scripts/make-art.mjs` into `public/art/`.

## deploy

cloudflare pages, build command `npm run build`, output directory `dist`.
