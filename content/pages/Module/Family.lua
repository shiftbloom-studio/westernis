--[[
  Module:Family — renders a compact family tree from the Characters Cargo table.
  {{#invoke:Family|tree|page=Aragorn II}}
]]
local p = {}

local function trim( s )
	return ( tostring( s or '' ):gsub( '^%s+', '' ):gsub( '%s+$', '' ) )
end

local function split( s )
	local out = {}
	for part in tostring( s or '' ):gmatch( '[^,]+' ) do
		part = trim( part )
		if part ~= '' then
			table.insert( out, part )
		end
	end
	return out
end

local function esc( s )
	return ( tostring( s ):gsub( '"', '' ) )
end

local function query( fields, where, limit )
	local ok, rows = pcall( mw.ext.cargo.query, 'Characters', fields, { where = where, limit = limit or 50 } )
	if ok and type( rows ) == 'table' then
		return rows
	end
	return {}
end

local function uniq( list )
	local seen, out = {}, {}
	for _, v in ipairs( list ) do
		if v ~= '' and not seen[ v ] then
			seen[ v ] = true
			table.insert( out, v )
		end
	end
	return out
end

local function node( title, class, label )
	local html = mw.html.create( 'div' ):addClass( 'wst-tree-node' )
	if class then
		html:addClass( class )
	end
	html:wikitext( '[[' .. title .. ']]' )
	if label then
		html:tag( 'span' ):addClass( 'wst-tree-label' ):wikitext( label )
	end
	return tostring( html )
end

local function row( title, items, class )
	if #items == 0 then
		return ''
	end
	local html = mw.html.create( 'div' ):addClass( 'wst-tree-row' ):addClass( class )
	html:tag( 'div' ):addClass( 'wst-tree-rowlabel' ):wikitext( title )
	local cell = html:tag( 'div' ):addClass( 'wst-tree-cells' )
	for _, it in ipairs( items ) do
		cell:wikitext( it )
	end
	return tostring( html )
end

function p.tree( frame )
	local args = frame.args
	local page = trim( args.page )
	if page == '' then
		page = mw.title.getCurrentTitle().text
	end
	local me = query( 'parentage,spouse,siblings,children', '_pageName="' .. esc( page ) .. '"', 1 )[ 1 ] or {}

	local parents = split( me.parentage )
	local spouses = split( me.spouse )
	local siblings = split( me.siblings )
	local children = split( me.children )

	-- reverse lookups
	for _, r in ipairs( query( '_pageName', 'children HOLDS "' .. esc( page ) .. '"' ) ) do
		table.insert( parents, r._pageName )
	end
	for _, r in ipairs( query( '_pageName', 'spouse HOLDS "' .. esc( page ) .. '"' ) ) do
		table.insert( spouses, r._pageName )
	end
	for _, r in ipairs( query( '_pageName', 'parentage HOLDS "' .. esc( page ) .. '"' ) ) do
		table.insert( children, r._pageName )
	end
	for _, r in ipairs( query( '_pageName', 'siblings HOLDS "' .. esc( page ) .. '"' ) ) do
		table.insert( siblings, r._pageName )
	end
	-- siblings via shared parents
	for _, par in ipairs( uniq( parents ) ) do
		for _, r in ipairs( query( '_pageName', 'parentage HOLDS "' .. esc( par ) .. '"' ) ) do
			if r._pageName ~= page then
				table.insert( siblings, r._pageName )
			end
		end
	end
	parents, spouses, siblings, children = uniq( parents ), uniq( spouses ), uniq( siblings ), uniq( children )

	-- grandparents
	local grandparents = {}
	for _, par in ipairs( parents ) do
		local prow = query( 'parentage', '_pageName="' .. esc( par ) .. '"', 1 )[ 1 ]
		if prow then
			for _, gp in ipairs( split( prow.parentage ) ) do
				table.insert( grandparents, gp )
			end
		end
		for _, r in ipairs( query( '_pageName', 'children HOLDS "' .. esc( par ) .. '"' ) ) do
			table.insert( grandparents, r._pageName )
		end
	end
	grandparents = uniq( grandparents )

	if #parents + #spouses + #siblings + #children + #grandparents == 0 then
		return '<div class="wst-tree wst-tree-empty">Noch ist keine Sippe verzeichnet. Trage <i>Eltern</i>, <i>Gemahl(in)</i> und <i>Kinder</i> in die Infobox ein.</div>'
	end

	local map = function( list, class )
		local out = {}
		for _, t in ipairs( list ) do
			table.insert( out, node( t, class ) )
		end
		return out
	end

	local html = {}
	table.insert( html, '<div class="wst-tree">' )
	table.insert( html, row( 'Großeltern', map( grandparents, 'wst-tree-gp' ), 'wst-tree-row-gp' ) )
	table.insert( html, row( 'Eltern', map( parents, 'wst-tree-parent' ), 'wst-tree-row-parents' ) )
	local mid = { node( page, 'wst-tree-self' ) }
	for _, s in ipairs( spouses ) do
		table.insert( mid, node( s, 'wst-tree-spouse', 'vermählt' ) )
	end
	for _, s in ipairs( siblings ) do
		table.insert( mid, node( s, 'wst-tree-sibling', 'Geschwister' ) )
	end
	table.insert( html, row( 'Generation', mid, 'wst-tree-row-self' ) )
	table.insert( html, row( 'Kinder', map( children, 'wst-tree-child' ), 'wst-tree-row-children' ) )
	table.insert( html, '</div>' )
	return table.concat( html )
end

return p
