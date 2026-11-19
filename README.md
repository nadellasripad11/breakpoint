# breakpoint

plan for the what if. landing page for breakpoint, a schedule stress-tester.

front end only for now: vite + vanilla js, gsap (scrolltrigger, splittext, drawsvg) and lenis for smooth scroll.

```
npm install
npm run dev      # http://localhost:5173  (add ?static to skip animations)
npm run build    # -> dist/
```

## layout units

on desktop `1rem = 100px` of the 1672px mockups, so the page scales exactly with the viewport. below 1024px it switches to a stacked layout.

## art

the capybara + rock scenery is cropped from the mockups in `art/` by `node scripts/make-art.mjs` into `public/art/`.

## deploy

cloudflare pages, build command `npm run build`, output directory `dist`.
