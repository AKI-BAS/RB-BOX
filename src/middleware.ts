import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip well-known probes entirely — Chrome DevTools, browsers, and OSes
  // hit these paths without cookies as part of normal browser behavior.
  // Redirecting them poisons speculative caches.
  if (pathname.startsWith('/.well-known/')) {
    return NextResponse.next({ request });
  }

  // Speculative requests (Next.js prefetch, Chrome preload/prerender) should
  // NEVER trigger a redirect. If we redirect them, the browser caches the
  // redirect and the user ends up on the wrong page.
  const isPrefetch =
    request.headers.get('purpose') === 'prefetch' ||
    request.headers.get('sec-purpose')?.includes('prefetch') ||
    request.headers.get('next-router-prefetch') === '1';

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  // DIAGNOSTIC — remove after debugging
  const sbCookieNames = request.cookies
    .getAll()
    .map((c) => c.name)
    .filter((n) => n.startsWith('sb-'));
  console.log(
    `[mw] ${pathname} | user=${user?.id ?? 'NONE'} | err=${userError?.message ?? '-'} | cookies=${sbCookieNames.join(',') || '(none)'} | prefetch=${isPrefetch}`,
  );

  // For prefetches, never redirect — just pass through as-is so the browser
  // doesn't cache a redirect to /login for a route the user IS authorized for.
  if (isPrefetch) return response;

  const isAuthRoute = pathname.startsWith('/login');
  const isDebug = pathname.startsWith('/debug');
  // /api/auth       — the login form's own API
  // /api/cron/*     — Vercel Cron; authenticates via Bearer CRON_SECRET header
  //                   inside the route handler, not via user session cookies
  const isPublicApi =
    pathname.startsWith('/api/auth') || pathname.startsWith('/api/cron');

  // Not signed in → send to /login
  if (!user && !isAuthRoute && !isDebug && !isPublicApi) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // Signed in but on /login → send home
  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  // /admin gate — check profile role
  if (user && pathname.startsWith('/admin')) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role !== 'admin') {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
