--[=[
  Module:Westernis — shared helpers for the Westernis infobox templates.

  {{#invoke:Westernis|links|Arathorn II, Gilraen}}      -> links to Arathorn II and Gilraen
  {{#invoke:Westernis|list|Narsil, Andúril}}             -> bullet list of links
  {{#invoke:Westernis|date|1. März|2931|Third Age}}      -> 1. März T.A. 2931 (era prefix from the era page)
  {{#invoke:Westernis|years|2931|3021|Third Age}}        -> T.A. 2931 – 3021
  {{#invoke:Westernis|era_prefix|Third Age}}             -> T.A.
  {{#invoke:Westernis|canon|Tolkien}}                    -> canon seal
  {{#invoke:Westernis|label|Battle}}                     -> Schlacht (stored value -> German label, Module:Westernis/labels)
  {{#invoke:Westernis|count|a, b, c}}                    -> 3
]=]
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

local function linkify( item )
	-- already a link, template, or external url: leave untouched
	if item:find( '^%[%[' ) or item:find( '^{{' ) or item:find( '^https?://' ) or item:find( '^%[' ) then
		return item
	end
	-- "Target|Label" syntax
	local target, label = item:match( '^(.-)|(.+)$' )
	if target then
		return '[[' .. trim( target ) .. '|' .. trim( label ) .. ']]'
	end
	return '[[' .. item .. ']]'
end

local function arg( frame, n )
	local v = frame.args[ n ]
	if v == nil and frame:getParent() then
		v = frame:getParent().args[ n ]
	end
	return trim( v )
end

-- Comma separated list -> comma separated links
function p.links( frame )
	local items = split( arg( frame, 1 ) )
	for i, item in ipairs( items ) do
		items[ i ] = linkify( item )
	end
	return table.concat( items, ', ' )
end

-- Comma separated list -> bullet list of links (for infobox rows)
function p.list( frame )
	local items = split( arg( frame, 1 ) )
	if #items == 0 then
		return ''
	end
	if #items == 1 then
		return linkify( items[ 1 ] )
	end
	local out = {}
	for _, item in ipairs( items ) do
		table.insert( out, '<li>' .. linkify( item ) .. '</li>' )
	end
	return '<ul class="wst-plainlist">' .. table.concat( out ) .. '</ul>'
end

function p.count( frame )
	return tostring( #split( arg( frame, 1 ) ) )
end

-- Era prefix: the era page's own "prefix" (Eras Cargo table) wins, so timelines and infoboxes
-- agree; the German Tolkien abbreviations below are only a fallback; then the era name itself.
local builtinPrefixes = {
	[ 'Years of the Lamps' ] = 'J.d.L.',
	[ 'Years of the Trees' ] = 'J.d.B.',
	[ 'First Age' ] = 'E.Z.',
	[ 'Second Age' ] = 'Z.Z.',
	[ 'Third Age' ] = 'D.Z.',
	[ 'Fourth Age' ] = 'V.Z.',
	[ 'Erstes Zeitalter' ] = 'E.Z.',
	[ 'Zweites Zeitalter' ] = 'Z.Z.',
	[ 'Drittes Zeitalter' ] = 'D.Z.',
	[ 'Viertes Zeitalter' ] = 'V.Z.',
}

local prefixCache = {}

local function eraPrefix( era )
	era = trim( era )
	if era == '' then
		return ''
	end
	if prefixCache[ era ] ~= nil then
		return prefixCache[ era ]
	end
	local prefix = builtinPrefixes[ era ] or era
	local ok, cargo = pcall( function() return mw.ext.cargo end )
	if ok and cargo and cargo.query then
		local okq, rows = pcall( cargo.query, 'Eras', 'prefix', {
			where = '_pageName="' .. era:gsub( '"', '' ) .. '"',
			limit = 1,
		} )
		if okq and rows and rows[ 1 ] and trim( rows[ 1 ].prefix ) ~= '' then
			prefix = trim( rows[ 1 ].prefix )
		end
	end
	prefixCache[ era ] = prefix
	return prefix
end

function p.era_prefix( frame )
	return eraPrefix( arg( frame, 1 ) )
end

-- date(day-text, year, era): "1. März T.A. 2931" linking the era page
function p.date( frame )
	local day, year, era = arg( frame, 1 ), arg( frame, 2 ), arg( frame, 3 )
	local parts = {}
	if day ~= '' then
		table.insert( parts, day )
	end
	local yearPart = ''
	if year ~= '' then
		yearPart = year
	end
	if era ~= '' then
		local label = era
		if yearPart ~= '' then
			label = eraPrefix( era ) .. ' ' .. yearPart
		end
		yearPart = '[[' .. era .. '|' .. label .. ']]'
	end
	if yearPart ~= '' then
		table.insert( parts, yearPart )
	end
	return table.concat( parts, ' ' )
end

-- years(start, end, era): "T.A. 2931 – 3021"
function p.years( frame )
	local y1, y2, era = arg( frame, 1 ), arg( frame, 2 ), arg( frame, 3 )
	if y1 == '' and y2 == '' then
		return ''
	end
	local prefix = eraPrefix( era )
	local label = trim( prefix .. ' ' .. y1 )
	if y2 ~= '' and y2 ~= y1 then
		label = label .. ' – ' .. y2
	end
	if era ~= '' then
		return '[[' .. era .. '|' .. label .. ']]'
	end
	return label
end

-- stored dropdown value -> German display label (unknown values pass through unchanged)
local labels = mw.loadData( 'Module:Westernis/labels' )
local function label( v )
	v = trim( v )
	return labels[ v ] or v
end

function p.label( frame )
	return label( arg( frame, 1 ) )
end

-- canon seal
function p.canon( frame )
	local c = arg( frame, 1 )
	if c == '' then
		return ''
	end
	local key = mw.ustring.lower( c ):gsub( '%s+', '-' )
	return '<span class="wst-canon wst-canon-' .. key .. '" title="Kanon: ' .. label( c ) .. '">' .. label( c ) .. '</span>'
end

-- yesno(value): "yes" / "" for use in #if
function p.yesno( frame )
	local v = mw.ustring.lower( arg( frame, 1 ) )
	if v == '' or v == 'no' or v == 'false' or v == '0' or v == 'n' then
		return ''
	end
	return 'yes'
end

return p
