// Serves the simulator at https://brunov.tech/tools/atmsim/ by forwarding those requests
// to its GitHub Pages deployment. Everything else goes to the normal site.
const UPSTREAM = 'https://brun0-v.github.io/atmega328p-simulator';
const PREFIX = '/tools/atmsim';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Relative asset paths need the trailing slash.
    if (url.pathname === PREFIX) {
      return Response.redirect(`${url.origin}${PREFIX}/${url.search}`, 301);
    }
    // The route pattern also matches e.g. /tools/atmsimfoo: pass those through untouched.
    if (!url.pathname.startsWith(PREFIX + '/')) return fetch(request);

    const headers = new Headers(request.headers);
    headers.delete('host');
    const res = await fetch(UPSTREAM + url.pathname.slice(PREFIX.length) + url.search, {
      method: request.method,
      headers,
      redirect: 'manual',
    });

    // Keep redirects from GitHub Pages on brunov.tech.
    const location = res.headers.get('location');
    if (location && location.startsWith(UPSTREAM)) {
      const h = new Headers(res.headers);
      h.set('location', PREFIX + location.slice(UPSTREAM.length));
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
