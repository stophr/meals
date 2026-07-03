// The "Costco → Pantrezy" bookmarklet. Runs inside the user's own logged-in Costco tab (no
// automation, no bot detection), scrapes product prices, and copies them to the clipboard as
// JSON to paste into the app. Best-effort DOM scraping — JSON-LD Product first (most robust),
// then generic product tiles. May need tuning once we see Costco's live markup.
const SOURCE = `(function(){
  var items=[];
  var seen={};
  function add(name,price,itemNumber){
    name=(name||'').replace(/\\s+/g,' ').trim();
    price=parseFloat(price);
    if(!name||!isFinite(price)||price<=0)return;
    var k=(itemNumber||name).toLowerCase();
    if(seen[k])return; seen[k]=1;
    items.push({name:name.slice(0,140),price:price,itemNumber:itemNumber?String(itemNumber):undefined});
  }
  // 1) schema.org Product JSON-LD
  document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){
    try{
      var j=JSON.parse(s.textContent);
      var arr=Array.isArray(j)?j:(j['@graph']||[j]);
      arr.forEach(function(o){
        if(!o)return;
        var t=o['@type']||'';
        if((''+t).toLowerCase().indexOf('product')<0)return;
        var off=o.offers; if(Array.isArray(off))off=off[0];
        var price=off&&(off.price||off.lowPrice);
        add(o.name,price,o.sku||o.productID||o.mpn);
      });
    }catch(e){}
  });
  // 2) generic product tiles (search / category / orders pages)
  if(items.length<2){
    var tiles=document.querySelectorAll('[automation-id*="productList"] , [data-testid*="product"], .product-tile, [class*="product-tile"], [class*="ProductTile"]');
    tiles.forEach(function(el){
      var nameEl=el.querySelector('[class*="description"],[class*="title"],[automation-id*="itemDescription"],a[href*="/product"]');
      var name=nameEl&&(nameEl.getAttribute('title')||nameEl.textContent);
      var pm=(el.textContent||'').match(/\\$\\s?([0-9]+(?:\\.[0-9]{2}))/);
      if(name&&pm)add(name,pm[1]);
    });
  }
  if(!items.length){alert('Pantrezy: no products found here. Open a Costco product page, search results, or Orders & Purchases.');return;}
  var payload=JSON.stringify({source:'costco',items:items});
  function ok(){alert('Pantrezy: copied '+items.length+' item(s). In the app: Settings → Import Costco prices → paste.');}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(payload).then(ok,function(){window.prompt('Copy this, paste into Pantrezy:',payload);});}
  else{window.prompt('Copy this, paste into Pantrezy:',payload);}
})();`;

/** The full javascript: URL to install as a bookmark. */
export const costcoBookmarkletHref = 'javascript:' + encodeURIComponent(SOURCE);
