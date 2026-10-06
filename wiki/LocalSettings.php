<?php
/**
 * Westernis — LocalSettings.php
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Copied into the image (docker/mediawiki/Dockerfile) and used by the wiki and jobrunner
 * containers. Secrets and host settings come from the container environment (.env next to
 * docker-compose.yml); nothing personal belongs in this file. After editing run
 * `pwsh scripts/wiki.ps1 sync` (push into the running containers) or `up` (rebuild).
 * Per-install overrides go in wiki/LocalSettings.local.php (untracked, loaded at the end).
 */
if ( !defined( 'MEDIAWIKI' ) ) {
	exit;
}

$wstEnv = static function ( string $key, $default = null ) {
	$v = getenv( $key );
	return ( $v === false || $v === '' ) ? $default : $v;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
$wgSitename = $wstEnv( 'WIKI_SITENAME', 'Westernis' );
$wgMetaNamespace = 'Westernis';
$wgLanguageCode = $wstEnv( 'WIKI_LANG', 'de' );   // German by default; users can pick English in their preferences
$wgLocaltimezone = $wstEnv( 'WIKI_TIMEZONE', 'Europe/Berlin' );
date_default_timezone_set( $wgLocaltimezone );

// ---------------------------------------------------------------------------
// URLs — MediaWiki lives in the document root; articles are served as /wiki/Title
// ---------------------------------------------------------------------------
$wgScriptPath = '';
$wgArticlePath = '/wiki/$1';
$wgUsePathInfo = true;
$wgResourceBasePath = $wgScriptPath;

$wstCanonical = $wstEnv( 'WIKI_SERVER', 'http://localhost:' . $wstEnv( 'WIKI_HOST_PORT', '8088' ) );
if ( PHP_SAPI !== 'cli' && !empty( $_SERVER['HTTP_HOST'] ) ) {
	// Follow whatever host the visitor typed (LAN IP, localhost, a hostname) so
	// links never bounce to a different address. CLI scripts use the canonical one.
	$wgServer = 'http://' . $_SERVER['HTTP_HOST'];
} else {
	$wgServer = $wstCanonical;
}
$wgCanonicalServer = $wstCanonical;

// ---------------------------------------------------------------------------
// Branding (assets live in ./wiki/assets on the host -> /assets in the container)
// ---------------------------------------------------------------------------
$wgLogos = [
	'1x' => '/assets/brand/logo.svg',
	'icon' => '/assets/brand/icon.svg',
	'wordmark' => [ 'src' => '/assets/brand/wordmark.svg', 'width' => 207, 'height' => 32 ],
	'tagline' => [ 'src' => '/assets/brand/tagline.svg', 'width' => 244, 'height' => 14 ],
];
$wgFavicon = '/assets/brand/favicon.ico';
$wgAppleTouchIcon = '/assets/brand/icon-180.png';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
$wgDBtype = 'mysql';
$wgDBserver = $wstEnv( 'WIKI_DB_HOST', 'db' );
$wgDBname = $wstEnv( 'MARIADB_DATABASE', 'westernis' );
$wgDBuser = $wstEnv( 'MARIADB_USER', 'westernis' );
$wgDBpassword = $wstEnv( 'MARIADB_PASSWORD', '' );
$wgDBprefix = '';
$wgDBssl = false;
$wgDBTableOptions = 'ENGINE=InnoDB, DEFAULT CHARSET=binary';

// No fallback: a published default secret would be known to everyone. Fail fast instead.
$wgSecretKey = $wstEnv( 'WIKI_SECRET_KEY' ) ?? throw new RuntimeException( 'WIKI_SECRET_KEY is not set (see .env.example)' );
$wgUpgradeKey = $wstEnv( 'WIKI_UPGRADE_KEY', false );   // unset: the web upgrader stays locked

// ---------------------------------------------------------------------------
// Caching & jobs. One memcached container is shared by the web server, the
// jobrunner and the CLI maintenance scripts, so cache invalidation (site CSS,
// parser cache, messages) is consistent everywhere. Sessions stay in the DB.
// ---------------------------------------------------------------------------
$wgMemCachedServers = [ $wstEnv( 'WIKI_CACHE_HOST', 'cache' ) . ':11211' ];
$wgMainCacheType = CACHE_MEMCACHED;
$wgMessageCacheType = CACHE_MEMCACHED;
$wgParserCacheType = CACHE_MEMCACHED;
$wgSessionCacheType = CACHE_DB;
$wgCacheDirectory = "$IP/cache";
// CDB files: with the 'array' store the German message list omits keys German inherits from English
// (sidebar, helppage, most Citizen strings), so MessageCache never loads their MediaWiki: overrides.
$wgLocalisationCacheConf['store'] = 'files';
$wgEnableSidebarCache = true;
$wgJobRunRate = 0;          // the jobrunner container drains the queue
$wgRunJobsAsync = false;
$wgMiserMode = false;        // keep Special:WantedPages & friends live (the AI uses them as a backlog)

// ---------------------------------------------------------------------------
// Email: off (private LAN wiki)
// ---------------------------------------------------------------------------
$wgEnableEmail = false;
$wgEnableUserEmail = false;
$wgEmailAuthentication = false;
$wgEnotifUserTalk = false;
$wgEnotifWatchlist = false;
$wgEmergencyContact = 'wiki@westernis.local';
$wgPasswordSender = 'wiki@westernis.local';

// ---------------------------------------------------------------------------
// Uploads & media
// ---------------------------------------------------------------------------
$wgEnableUploads = true;
$wgUploadPath = "$wgScriptPath/images";
$wgUploadDirectory = "$IP/images";
$wgUseImageMagick = true;
$wgImageMagickConvertCommand = '/usr/bin/convert';
$wgSVGConverter = 'rsvg';
$wgSVGConverterPath = '/usr/bin';
$wgSVGNativeRendering = 'partial';   // small SVGs (ornaments, icons) are served as-is and stay crisp
$wgMaxImageArea = 6.4e7;             // 64 MP source images (big maps)
$wgMaxShellMemory = 1024 * 1024;     // KB
$wgMaxShellTime = 300;
$wgMaxShellWallClockTime = 300;
$wgMaxUploadSize = 256 * 1024 * 1024;
$wgFileExtensions = [
	'png', 'gif', 'jpg', 'jpeg', 'webp', 'avif', 'svg',
	'pdf',
	'mp4', 'webm', 'mp3', 'ogg', 'oga', 'ogv', 'flac', 'wav',
	'json', 'txt',
];
$wgStrictFileExtensions = true;
$wgAllowCopyUploads = true;
$wgCopyUploadsFromSpecialUpload = true;
$wgAllowExternalImages = false;
$wgShowEXIF = true;
$wgResponsiveImages = true;
$wgThumbLimits = [ 150, 200, 250, 300, 400, 500, 640 ];
$wgDefaultUserOptions['thumbsize'] = 4;
$wgImageLimits[] = [ 2048, 2048 ];
$wgPdfProcessor = '/usr/bin/gs';
$wgPdfPostProcessor = '/usr/bin/convert';
$wgPdfInfo = '/usr/bin/pdfinfo';
$wgPdftoText = '/usr/bin/pdftotext';

// ---------------------------------------------------------------------------
// Permissions — everyone on the LAN may read, only logged-in users may edit,
// no self-registration. (For a login-only wiki set ['*']['read'] = false.)
// ---------------------------------------------------------------------------
$wgGroupPermissions['*']['read'] = true;
$wgGroupPermissions['*']['edit'] = false;
$wgGroupPermissions['*']['createpage'] = false;
$wgGroupPermissions['*']['createtalk'] = false;
$wgGroupPermissions['*']['createaccount'] = false;
$wgGroupPermissions['user']['upload'] = true;
$wgGroupPermissions['user']['upload_by_url'] = true;
$wgGroupPermissions['user']['reupload'] = true;
$wgGroupPermissions['user']['reupload-own'] = true;
$wgGroupPermissions['user']['movefile'] = true;
$wgGroupPermissions['user']['editcontentmodel'] = true;
$wgGroupPermissions['sysop']['interwiki'] = true;
$wgGroupPermissions['*']['runcargoqueries'] = true;      // Cargo API queries (Forge MCP, drilldown, Lua)
$wgGroupPermissions['user']['runcargoqueries'] = true;
$wgGroupPermissions['sysop']['recreatecargodata'] = true;
$wgGroupPermissions['sysop']['deletecargodata'] = true;
$wgEnableBotPasswords = true;
$wgAutoConfirmAge = 0;
$wgRateLimits = [];                 // no throttling for the single author (and the AI)
$wgAllowUserCss = true;
$wgAllowUserJs = true;
$wgUseSiteCss = true;
$wgUseSiteJs = true;
$wgAllowSiteCSSOnRestrictedPages = true;
$wgRightsPage = '';
$wgRightsUrl = $wstEnv( 'WIKI_RIGHTS_URL', '' );     // optional content licence notice in the footer
$wgRightsText = $wstEnv( 'WIKI_RIGHTS_TEXT', '' );
$wgRightsIcon = '';
$wgPingback = false;
// WIKI_DEBUG=1 in .env: readable error pages with stack traces (private wikis); off by default
$wgShowExceptionDetails = filter_var( $wstEnv( 'WIKI_DEBUG', '0' ), FILTER_VALIDATE_BOOLEAN );

// ---------------------------------------------------------------------------
// Namespaces (declared before any extension loads)
//   Chronicle: your own narratives / stories set in Westernis
//   Notes:     out-of-universe notes, AI drafts, worldbuilding scratch pages
// ---------------------------------------------------------------------------
define( 'NS_CHRONICLE', 3000 );
define( 'NS_CHRONICLE_TALK', 3001 );
define( 'NS_NOTES', 3002 );
define( 'NS_NOTES_TALK', 3003 );
$wgExtraNamespaces[NS_CHRONICLE] = 'Chronicle';
$wgExtraNamespaces[NS_CHRONICLE_TALK] = 'Chronicle_talk';
$wgExtraNamespaces[NS_NOTES] = 'Notes';
$wgExtraNamespaces[NS_NOTES_TALK] = 'Notes_talk';
$wgContentNamespaces[] = NS_CHRONICLE;
$wgNamespacesWithSubpages[NS_MAIN] = true;
$wgNamespacesWithSubpages[NS_CHRONICLE] = true;
$wgNamespacesWithSubpages[NS_NOTES] = true;
$wgNamespacesWithSubpages[NS_PROJECT] = true;
$wgNamespacesToBeSearchedDefault[NS_MAIN] = true;
$wgNamespacesToBeSearchedDefault[NS_CHRONICLE] = true;
$wgNamespacesToBeSearchedDefault[NS_NOTES] = true;
$wgNamespacesToBeSearchedDefault[NS_FILE] = true;
$wgNamespacesToBeSearchedDefault[NS_CATEGORY] = true;

// ---------------------------------------------------------------------------
// Skin
// ---------------------------------------------------------------------------
wfLoadSkin( 'Citizen' );
wfLoadSkin( 'Vector' );
$wgDefaultSkin = 'citizen';
$wgCitizenCompat = true;
$wgCitizenThemeColor = '#0b0a12';
$wgCitizenEnableCollapsibleSections = true;
$wgCitizenShowPageTools = true;
$wgCitizenEnableDrawerSiteStats = false;   // the drawer shows the codex, not housekeeping numbers
$wgCitizenEnablePreferences = true;
$wgCitizenEnableShare = false;
$wgCitizenEnableManifest = true;
$wgCitizenManifestOptions = [
	'background_color' => '#0b0a12',
	'theme_color' => '#0b0a12',
	'short_name' => 'Westernis',
	'description' => 'Chronicles of Westernis',
	'icons' => [],
];
$wgCitizenOverflowNowrapClasses = [ 'noresize', 'citizen-table-nowrap', 'cargoDynamicTable', 'dataTable', 'wst-nowrap' ];

// ---------------------------------------------------------------------------
// Extensions bundled with MediaWiki
// ---------------------------------------------------------------------------
wfLoadExtensions( [
	'CategoryTree',
	'Cite',
	'CodeEditor',
	'Gadgets',
	'ImageMap',
	'InputBox',
	'Math',
	'MultimediaViewer',
	'Nuke',
	'PageImages',
	'ParserFunctions',
	'PdfHandler',
	'Poem',
	'ReplaceText',
	'Scribunto',
	'SyntaxHighlight_GeSHi',
	'TemplateData',
	'TemplateStyles',
	'TextExtracts',
	'VisualEditor',
	'WikiEditor',
] );

// ---------------------------------------------------------------------------
// Extensions added in docker/mediawiki/Dockerfile
// ---------------------------------------------------------------------------
wfLoadExtensions( [
	'Cargo',
	'PageForms',
	'PortableInfobox',
	'DynamicPageList4',
	'DisplayTitle',
	'LabeledSectionTransclusion',
	'TabberNeue',
	'ShortDescription',
	'Popups',
	'RelatedArticles',
	'Lingo',
	'DataMaps',
	'Mermaid',
	'Network',
	'CodeMirror',
	'CharInsert',
	'MsUpload',
	'SimpleBatchUpload',
] );

// ---------------------------------------------------------------------------
// Extension configuration
// ---------------------------------------------------------------------------
// Templates & Lua
$wgPFEnableStringFunctions = true;
$wgScribuntoDefaultEngine = 'luasandbox';
$wgScribuntoUseGeSHi = true;
$wgScribuntoUseCodeEditor = true;
$wgExpensiveParserFunctionLimit = 500;
$wgAllowSlowParserFunctions = true;
$wgMaxArticleSize = 4096;

// Math (native MathML, no external renderer)
$wgMathValidModes = [ 'native', 'source' ];
$wgDefaultUserOptions['math'] = 'native';

// Editing
$wgVisualEditorEnableWikitext = true;
$wgVisualEditorUseSingleEditTab = false;
$wgVisualEditorShowBetaWelcome = false;
$wgVisualEditorAvailableNamespaces['Chronicle'] = true;
$wgVisualEditorAvailableNamespaces['Notes'] = true;
$wgVisualEditorAvailableNamespaces['Project'] = true;
$wgDefaultUserOptions['visualeditor-enable'] = 1;
$wgDefaultUserOptions['visualeditor-editor'] = 'visualeditor';
$wgDefaultUserOptions['usebetatoolbar'] = 1;
$wgDefaultUserOptions['usecodemirror'] = 1;
$wgDefaultUserOptions['usecodemirror-colorblind'] = 0;
$wgDefaultUserOptions['editfont'] = 'monospace';
$wgDefaultUserOptions['rcdays'] = 30;
$wgDefaultUserOptions['watchdefault'] = 0;
$wgDefaultUserOptions['watchcreations'] = 0;
$wgCiteResponsiveReferences = true;

// Reading experience
$wgDefaultUserOptions['popups'] = '1';
$wgDefaultUserOptions['popups-reference-previews'] = '1';
$wgPopupsHideOptInOnPreferencesPage = false;
$wgExtractsRemoveClasses = [ '.portable-infobox', '.navbox', '.wst-noexcerpt', '.mw-editsection', 'table', 'figure' ];
$wgPageImagesNamespaces = [ NS_MAIN, NS_CHRONICLE, NS_NOTES, NS_FILE ];
$wgPageImagesLeadSectionOnly = false;
$wgPageImagesExpandOpenSearchXml = true;
$wgShortDescriptionEnableTagline = true;
$wgShortDescriptionExtendOpenSearchXml = true;
$wgRelatedArticlesUseCirrusSearch = false;
$wgRelatedArticlesDescriptionSource = 'textextracts';
$wgRelatedArticlesFooterAllowedSkins = [ 'citizen', 'vector-2022' ];
$wgRelatedArticlesFooterAllowedNamespaces = [ NS_MAIN, NS_CHRONICLE ];
$wgRelatedArticlesCardLimit = 6;
$wgTabberNeueParseTabName = true;
$wgTabberNeueUpdateLocationOnTabChange = false;
$wgTabberNeueEnableAnimation = true;
$wgexLingoPage = 'Glossary';
$wgexLingoDisplayOnce = false;
$wgexLingoUseNamespaces = [ NS_MAIN => true, NS_CHRONICLE => true ];
$wgDisplayTitleHideSubtitle = true;
$wgRestrictDisplayTitle = false;

// Structured data
$wgCargoDefaultQueryLimit = 200;
$wgCargoMaxQueryLimit = 5000;
$wgCargoDefaultStringBytes = 300;
$wgCargoPageDataColumns = [ 'creationDate', 'modificationDate', 'categories', 'pageNamespace', 'isRedirect' ];
$wgPageFormsSimpleUpload = true;
$wgPageFormsUseDisplayTitle = true;
$wgPageFormsRenameEditTabs = true;      // "Edit with form" becomes "Edit", source edit becomes "Edit source"
$wgPageFormsRenameMainEditTab = true;
$wgPageFormsLinkAllRedLinksToForms = false;
$wgPageFormsAutoeditNamespaces = [ NS_MAIN, NS_CHRONICLE, NS_NOTES ];
$wgPortableInfoboxCustomImageWidth = 420;
$wgPortableInfoboxResponsiblyOpenCollapsed = true;
$wgPortableInfoboxUseHeadings = false;   // divs, not h2/h3: keeps TextExtracts/Popups previews and the TOC clean
$wgDPLAllowUnlimitedCategories = true;
$wgDPLAllowUnlimitedResults = true;
$wgDPLMaxResultCount = 2000;
$wgDPLFunctionalRichness = 4;

// Maps, graphs, media
$wgDataMapsEnableCreateMap = true;
$wgExtraNamespaces[2900] = 'Karte';            // DataMaps' Map: namespace, shown in German (Map: keeps working)
$wgExtraNamespaces[2901] = 'Karte_Diskussion';
$wgDataMapsEnableVisualEditor = true;
$wgDataMapsEnableTransclusionAlias = true;
$mermaidgDefaultTheme = 'neutral';
$wgPageNetworkExcludedNamespaces = [ NS_USER, NS_PROJECT, NS_MEDIAWIKI, NS_TEMPLATE, NS_HELP, NS_CATEGORY, NS_FILE, NS_NOTES ];
$wgPageNetworkExcludeTalkPages = true;
$wgPageNetworkEnableDisplayTitle = true;
$wgPageNetworkLabelMaxLength = 28;
$wgPageNetworkOptions = [
	'nodes' => [
		'shape' => 'dot',
		'size' => 14,
		'font' => [ 'face' => 'Cinzel, serif', 'size' => 15, 'color' => '#d9c8a0' ],
		'color' => [ 'background' => '#8c6a2b', 'border' => '#e3c16f', 'highlight' => [ 'background' => '#e3c16f', 'border' => '#fff2c4' ] ],
	],
	'edges' => [ 'color' => [ 'color' => '#6b5a3a', 'highlight' => '#e3c16f' ], 'smooth' => [ 'type' => 'continuous' ], 'width' => 1.5 ],
	'physics' => [ 'barnesHut' => [ 'gravitationalConstant' => -4000, 'springLength' => 140, 'springConstant' => 0.02 ], 'stabilization' => [ 'iterations' => 200 ] ],
	'interaction' => [ 'hover' => true, 'tooltipDelay' => 150 ],
];

// Uploads in the editor
$wgMSU_useDragDrop = true;
$wgMSU_showAutoCat = true;
$wgMSU_checkAutoCat = false;
$wgMSU_confirmReplace = true;
$wgMSU_imgParams = 'thumb|400px';
$wgMSU_uploadsize = '256mb';
$wgSimpleBatchUploadMaxFilesPerBatch = [ '*' => 200 ];

// TemplateStyles may reference same-origin theme assets and uploads
$wgTemplateStylesAllowedUrls = [
	'audio' => [ '<^/images/>' ],
	'image' => [ '<^/assets/>', '<^/images/>' ],
	'svg' => [ '<^/assets/>', '<^/images/>' ],
	'font' => [ '<^/assets/fonts/>' ],
	'css' => [],
];

// Misc polish
$wgExternalLinkTarget = '_blank';
$wgUseInstantCommons = false;
$wgDiff3 = '/usr/bin/diff3';
$wgRCMaxAge = 365 * 24 * 3600;
$wgEnableCanonicalServerLink = false;
$wgCategoryCollation = 'uca-de-u-kn';   // German sorting; after changing run updateCollation --force

unset( $wgFooterIcons['poweredby'] );

// Footer links: the legal notice (fan-project disclaimer, licences; page Project:Legal from
// tools/gen-entities/samples.js) and the source code of the running version (AGPL-3.0 section 13).
// Forks that change the code set WIKI_SOURCE_URL to their own repository.
$wstSourceUrl = $wstEnv( 'WIKI_SOURCE_URL', 'https://github.com/shiftbloom-studio/westernis' );
$wgHooks['SkinAddFooterLinks'][] = static function ( $skin, string $key, array &$footerItems ) use ( $wstSourceUrl ) {
	if ( $key !== 'places' ) {
		return;
	}
	$de = str_starts_with( $skin->getLanguage()->getCode(), 'de' );
	$legal = \MediaWiki\Title\Title::newFromText( 'Project:Legal' );
	if ( $legal && $legal->isKnown() ) {
		$footerItems['wst-legal'] = \MediaWiki\Html\Html::element( 'a',
			[ 'href' => $legal->getLocalURL(), 'title' => $legal->getPrefixedText() ],
			$de ? 'Rechtliches' : 'Legal notice' );
	}
	$footerItems['wst-source'] = \MediaWiki\Html\Html::element( 'a',
		[ 'href' => $wstSourceUrl, 'rel' => 'noopener' ],
		$de ? 'Quellcode (AGPL)' : 'Source code (AGPL)' );
};

// ---------------------------------------------------------------------------
// Theme bootstrap: runs in <head>, before the first paint.
//  - preloads the fonts the first screen needs (otherwise they are found only after the site CSS);
//  - sets html.wst-day / wst-night / wst-motion from Citizen's client-pref classes (already applied
//    inline at the top of <head>), so the right palette and the dawn hero paint first time;
//  - loads the theme script with defer instead of waiting for the ResourceLoader queue.
// Bump WST_ASSET_VERSION after editing wiki/assets/js or the fonts.
// ---------------------------------------------------------------------------
define( 'WST_ASSET_VERSION', '9' );
$wgHooks['BeforePageDisplay'][] = static function ( $out, $skin ) {
	$fonts = [ 'EBGaramond.woff2', 'Cinzel.woff2', 'CormorantGaramond-Italic.woff2' ];
	if ( $out->getTitle() && $out->getTitle()->isMainPage() ) {
		$fonts[] = 'CinzelDecorative-Bold.woff2';
	}
	foreach ( $fonts as $font ) {
		$out->addLink( [ 'rel' => 'preload', 'href' => "/assets/fonts/$font", 'as' => 'font', 'type' => 'font/woff2', 'crossorigin' => '' ] );
	}
	// Reads the stored client preferences itself (Citizen applies them only at the end of <head>).
	$out->addHeadItem( 'wst-theme', \MediaWiki\Html\Html::inlineScript(
		"(function(){var h=document.documentElement,c=h.classList,s='';try{s=localStorage.getItem('mwclientpreferences')||''}catch(e){}" .
		"function p(k,d){var r=new RegExp(k+'-clientpref-([a-z0-9]+)'),x=r.exec(s)||r.exec(h.className);return x?x[1]:d}" .
		"var t=p('skin-theme','night'),m=window.matchMedia,d=t==='day'||(t==='os'&&m&&m('(prefers-color-scheme: light)').matches);" .
		"c.add(d?'wst-day':'wst-night','wst-js');if(p('citizen-feature-performance-mode','0')!=='1')c.add('wst-motion');}());"
	) );
	$out->addHeadItem( 'wst-js', \MediaWiki\Html\Html::element( 'script', [ 'src' => '/assets/js/westernis.js?v=' . WST_ASSET_VERSION, 'defer' => true ] ) );
};

// Cloudflare layer: present only in the cloud image (cloud/image/Dockerfile), loaded before the local overrides
if ( is_readable( "$IP/LocalSettings.cloud.php" ) ) {
	require_once "$IP/LocalSettings.cloud.php";
}

// ---------------------------------------------------------------------------
// Optional per-install overrides (untracked, not shipped): put them in wiki/LocalSettings.local.php;
// the Dockerfile and `wiki.ps1 sync` copy it next to this file when it exists.
// ---------------------------------------------------------------------------
if ( is_readable( "$IP/LocalSettings.local.php" ) ) {
	require_once "$IP/LocalSettings.local.php";
}
