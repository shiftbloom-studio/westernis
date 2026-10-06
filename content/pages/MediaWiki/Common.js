/* Westernis — site JavaScript. Keep this file tiny and ES2017-safe.
 * The theme classes (html.wst-day / wst-night / wst-motion) are first set by an inline script in the page
 * head (LocalSettings BeforePageDisplay hook) so the right palette paints first; this keeps them in sync
 * when Citizen's theme or performance-mode switches change the html classes later.
 * /assets/js/westernis.js is loaded by the same hook with `defer`. */
( function () {
	var html = document.documentElement;
	var lightQuery = window.matchMedia ? window.matchMedia( '(prefers-color-scheme: light)' ) : null;

	function sync() {
		var cls = html.classList;
		var day = cls.contains( 'skin-theme-clientpref-day' ) ||
			( cls.contains( 'skin-theme-clientpref-os' ) && lightQuery && lightQuery.matches );
		cls.toggle( 'wst-day', day );
		cls.toggle( 'wst-night', !day );
		cls.toggle( 'wst-motion', !cls.contains( 'citizen-feature-performance-mode-clientpref-1' ) );
	}
	html.classList.add( 'wst-js' );
	sync();
	if ( lightQuery && lightQuery.addEventListener ) {
		lightQuery.addEventListener( 'change', sync );
	}
	new MutationObserver( sync ).observe( html, { attributes: true, attributeFilter: [ 'class' ] } );
}() );
