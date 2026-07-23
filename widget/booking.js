(function () {
  'use strict';

  var OVERLAY_ID = 'ph-booking-overlay';

  function init() {
    var targets = document.querySelectorAll('#ph-booking-widget, [data-ph-widget]');
    for (var i = 0; i < targets.length; i++) {
      mount(targets[i]);
    }
  }

  function mount(el) {
    var slug = el.getAttribute('data-slug');
    // The slug becomes the iframe's hostname label — a value containing '/', '@', '?', '#'
    // would reshape the URL authority and point the iframe off-domain. Silently no-op on
    // anything that isn't a plain DNS label.
    if (!slug || !/^[a-z0-9-]{1,63}$/i.test(slug)) return;

    var practitioner = el.getAttribute('data-practitioner');
    var widgetType = el.getAttribute('data-type') || 'booking';
    var defaultText = widgetType === 'contact' ? 'Contact Us' : 'Request Appointment';
    var buttonText = el.getAttribute('data-button-text') || defaultText;
    // The color is concatenated into cssText — accept only a hex value or a bare color
    // keyword so a stray ';' or 'url(' in the attribute can't smuggle extra declarations.
    var buttonColor = el.getAttribute('data-button-color') || '#228be6';
    if (!/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30})$/.test(buttonColor)) buttonColor = '#228be6';

    var btn = document.createElement('button');
    btn.textContent = buttonText;
    btn.style.cssText =
      'background:' + buttonColor + ';color:#fff;border:none;padding:12px 24px;' +
      'border-radius:6px;font-size:16px;font-family:inherit;cursor:pointer;' +
      'transition:opacity .2s;';
    btn.onmouseenter = function () { btn.style.opacity = '0.85'; };
    btn.onmouseleave = function () { btn.style.opacity = '1'; };

    btn.addEventListener('click', function () {
      openOverlay(slug, practitioner, widgetType, el);
    });

    el.appendChild(btn);
  }

  var ATTRIBUTION_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];

  function buildSrc(slug, practitioner, widgetType) {
    var page = widgetType === 'contact' ? '/contact' : '/book';
    var url = 'https://' + slug + '.securehealth.me' + page + '?embed=true';
    if (practitioner && widgetType !== 'contact') url += '&practitioner=' + encodeURIComponent(practitioner);
    // Forward the parent page's ad/campaign params into the iframe — the booking page can't
    // see the parent URL, so attribution would otherwise die at the widget boundary. ph_page /
    // ph_ref carry the parent page URL and its referrer for the same reason.
    try {
      var parentParams = new URLSearchParams(window.location.search);
      for (var i = 0; i < ATTRIBUTION_PARAMS.length; i++) {
        var v = parentParams.get(ATTRIBUTION_PARAMS[i]);
        if (v) url += '&' + ATTRIBUTION_PARAMS[i] + '=' + encodeURIComponent(v.slice(0, 500));
      }
      url += '&ph_page=' + encodeURIComponent(window.location.href.slice(0, 500));
      if (document.referrer) url += '&ph_ref=' + encodeURIComponent(document.referrer.slice(0, 500));
    } catch (e) {
      // Attribution is best-effort — never block the widget itself.
    }
    return url;
  }

  function openOverlay(slug, practitioner, widgetType, targetEl) {
    if (document.getElementById(OVERLAY_ID)) return;

    var dialogLabel = widgetType === 'contact' ? 'Contact form' : 'Appointment request form';
    var previousFocus = document.activeElement;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', dialogLabel);
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;' +
      'background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;' +
      'opacity:0;transition:opacity .3s ease;';

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00D7';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText =
      'position:absolute;top:12px;right:16px;background:none;border:none;color:#fff;' +
      'font-size:32px;cursor:pointer;line-height:1;z-index:1;padding:4px 8px;';

    var iframe = document.createElement('iframe');
    iframe.src = buildSrc(slug, practitioner, widgetType);
    iframe.setAttribute('title', dialogLabel);
    iframe.style.cssText =
      'border:none;background:#fff;width:100%;height:100%;' +
      'border-radius:0;max-width:none;max-height:none;';

    // Desktop styles
    if (window.innerWidth >= 768) {
      iframe.style.maxWidth = '960px';
      iframe.style.maxHeight = '85vh';
      iframe.style.borderRadius = '12px';
      iframe.style.width = '95vw';
      iframe.style.height = '90vh';
    }

    overlay.appendChild(closeBtn);
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);

    // Trigger fade-in on next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.style.opacity = '1';
      });
    });

    closeBtn.focus();

    function close() {
      removeOverlay();
    }

    function closeAndComplete() {
      removeOverlay();
      targetEl.dispatchEvent(new CustomEvent('ph-booking-complete', { bubbles: true }));
    }

    closeBtn.addEventListener('click', close);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    function onKey(e) {
      if (e.key === 'Escape') {
        close();
        return;
      }
      // Focus trap, backward edge: the close button is the first (and only) focusable
      // element in the overlay before the iframe, so Shift+Tab from it must wrap to the
      // iframe instead of escaping into the page behind the dialog. (Keydowns inside the
      // iframe never reach this document — the forward edge is handled by onFocusIn.)
      if (e.key === 'Tab' && e.shiftKey && document.activeElement === closeBtn) {
        e.preventDefault();
        iframe.focus();
      }
    }
    document.addEventListener('keydown', onKey);

    // Focus trap, forward edge: tabbing past the end of the iframe's content (or any other
    // way focus lands on the page behind the dialog) pulls focus back into the overlay.
    function onFocusIn(e) {
      if (e.target && e.target.nodeType === 1 && !overlay.contains(e.target)) {
        closeBtn.focus();
      }
    }
    document.addEventListener('focusin', onFocusIn);

    function onMessage(e) {
      if (!e.origin || !e.origin.match(/\.securehealth\.me$/)) return;
      var data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ph-widget-close') close();
      if (data.type === 'ph-widget-complete') closeAndComplete();
    }
    window.addEventListener('message', onMessage);

    // Store cleanup refs on overlay
    overlay._pnCleanup = function () {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('message', onMessage);
      if (previousFocus && previousFocus.focus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }

  function removeOverlay() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    if (overlay._pnCleanup) overlay._pnCleanup();
    overlay.style.opacity = '0';
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 300);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
