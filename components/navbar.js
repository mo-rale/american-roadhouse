/* Shared navbar markup. Edit this file to update the navigation everywhere. */
window.AmericanRoadhouseNavbar = String.raw`<nav id="site-nav" aria-label="Primary navigation">
  <div class="container nav-inner">
    <a href="index.html" class="nav-logo">
      <img src="assets/brand/logo-mark.png" alt="American Roadhouse logo" class="nav-logo-mark">
      American <span>Roadhouse</span>
    </a>
    <div class="nav-links">
      <a href="rooms.html">Rooms</a>
      <a href="restaurant.html">Restaurant</a>
      <a href="order.html">Order</a>
      <a href="gallery.html">Gallery</a>
      <a href="about.html">About</a>
      <a href="location.html">Location</a>
      <a href="contact.html">Contact</a>
    </div>
    <div style="display:flex;align-items:center;gap:14px;">
      <a href="contact.html?tab=booking#forms" class="btn btn-brass nav-cta btn-sm">Book Now</a>
      <button class="nav-toggle" id="menu-open" aria-label="Open menu" aria-controls="mobile-menu" aria-expanded="false">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
    </div>
  </div>
</nav>

<div class="mobile-menu" id="mobile-menu">
  <button class="close-btn" id="menu-close" aria-label="Close menu">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
  </button>
  <a href="rooms.html">Rooms</a>
  <a href="restaurant.html">Restaurant</a>
  <a href="order.html">Order</a>
  <a href="gallery.html">Gallery</a>
  <a href="about.html">About</a>
  <a href="location.html">Location</a>
  <a href="contact.html">Contact</a>
  <a href="contact.html?tab=booking#forms" class="btn btn-brass mm-cta">Book Now</a>
  <a href="tel:+639158754860" class="mm-phone">Call 0915 875 4860</a>
</div>

<div id="mobile-bottom-bar">
  <a href="tel:+639158754860">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 0 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
    Call
  </a>
  <a href="contact.html?tab=booking#forms" class="bar-book">Book Now</a>
</div>`;
