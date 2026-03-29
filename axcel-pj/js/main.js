/* ============================================================
   AXCEL PARTNERS – HubSpot CMS Theme JS
   ============================================================ */

(function () {
  'use strict';

  /* ── Mobile Nav Toggle ── */
  var mobileToggle = document.querySelector('.mobile-toggle');
  var mainNav = document.querySelector('.main-nav');

  if (mobileToggle && mainNav) {
    mobileToggle.addEventListener('click', function () {
      mainNav.classList.toggle('open');
      this.setAttribute('aria-expanded', mainNav.classList.contains('open'));
    });

    // Mobile sub-menu toggle
    var hasChildren = mainNav.querySelectorAll('.menu-item-has-children > a');
    hasChildren.forEach(function (link) {
      link.addEventListener('click', function (e) {
        if (window.innerWidth <= 768) {
          e.preventDefault();
          var parent = this.parentElement;
          parent.classList.toggle('open');
        }
      });
    });
  }

  /* ── Team Member Modals ── */
  function openModal(modalId) {
    var overlay = document.getElementById(modalId);
    if (overlay) {
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal(overlay) {
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  // Open on card/name click
  document.querySelectorAll('[data-modal-target]').forEach(function (trigger) {
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      openModal(this.getAttribute('data-modal-target'));
    });
  });

  // Close on X button
  document.querySelectorAll('.team-modal-close').forEach(function (btn) {
    btn.addEventListener('click', function () {
      closeModal(this.closest('.team-modal-overlay'));
    });
  });

  // Close on overlay background click
  document.querySelectorAll('.team-modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal(overlay);
    });
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.team-modal-overlay.active').forEach(closeModal);
    }
  });

  /* ── CTA Contact Form Toggle ── */
  var showFormBtn = document.getElementById('show-contact-form');
  var formWrap = document.getElementById('contact-form-wrap');

  if (showFormBtn && formWrap) {
    showFormBtn.addEventListener('click', function (e) {
      e.preventDefault();
      formWrap.classList.toggle('visible');
      if (formWrap.classList.contains('visible')) {
        formWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  /* ── News Slider ── */
  var sliderTrack = document.querySelector('.news-track');
  var slides = sliderTrack ? sliderTrack.querySelectorAll('.news-slide') : [];
  var prevBtn = document.querySelector('.slider-btn.prev');
  var nextBtn = document.querySelector('.slider-btn.next');
  var currentSlide = 0;
  var slidesPerView = 3;

  function updateSlidesPerView() {
    if (window.innerWidth <= 768) slidesPerView = 1;
    else if (window.innerWidth <= 1024) slidesPerView = 2;
    else slidesPerView = 3;
  }

  function getSlideWidth() {
    if (!sliderTrack) return 0;
    var slideEl = sliderTrack.querySelector('.news-slide');
    if (!slideEl) return 0;
    var style = window.getComputedStyle(slideEl);
    return slideEl.offsetWidth + parseInt(style.marginRight || 30);
  }

  function goToSlide(index) {
    if (!sliderTrack || slides.length === 0) return;
    var max = Math.max(0, slides.length - slidesPerView);
    currentSlide = Math.min(Math.max(index, 0), max);
    var offset = currentSlide * getSlideWidth();
    sliderTrack.style.transform = 'translateX(-' + offset + 'px)';
  }

  if (prevBtn) prevBtn.addEventListener('click', function () { goToSlide(currentSlide - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { goToSlide(currentSlide + 1); });

  window.addEventListener('resize', function () {
    updateSlidesPerView();
    goToSlide(currentSlide);
  });

  updateSlidesPerView();

  /* ── Back to Top ── */
  var backToTop = document.getElementById('back-to-top');
  if (backToTop) {
    window.addEventListener('scroll', function () {
      backToTop.classList.toggle('show', window.scrollY > 300);
    });
    backToTop.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ── HubSpot Form Submit (native) ── */
  var contactForm = document.getElementById('axcel-contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = contactForm.querySelector('[type=submit]');
      btn.textContent = 'Invio in corso...';
      btn.disabled = true;

      // HubSpot Forms API submission
      var portalId = contactForm.getAttribute('data-portal-id');
      var formGuid = contactForm.getAttribute('data-form-guid');

      if (!portalId || !formGuid) {
        // Fallback message if not configured
        showFormMessage(contactForm, 'Grazie! Ti risponderemo al più presto.', 'success');
        contactForm.reset();
        btn.disabled = false;
        btn.textContent = 'Invia il tuo messaggio';
        return;
      }

      var fields = [];
      new FormData(contactForm).forEach(function (value, key) {
        if (!key.startsWith('_')) fields.push({ name: key, value: value });
      });

      fetch('https://api.hsforms.com/submissions/v3/integration/submit/' + portalId + '/' + formGuid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: fields })
      })
        .then(function (res) {
          if (res.ok) {
            showFormMessage(contactForm, 'Grazie! Ti risponderemo al più presto.', 'success');
            contactForm.reset();
          } else {
            showFormMessage(contactForm, 'Errore nell\'invio. Riprova più tardi.', 'error');
          }
        })
        .catch(function () {
          showFormMessage(contactForm, 'Errore di rete. Riprova più tardi.', 'error');
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Invia il tuo messaggio';
        });
    });
  }

  function showFormMessage(form, message, type) {
    var existing = form.querySelector('.form-message');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'form-message form-message--' + type;
    el.textContent = message;
    el.style.cssText = 'padding:14px;margin-top:12px;font-size:14px;border-radius:2px;background:' +
      (type === 'success' ? '#eaf7ea;color:#2d6a2d;border:1px solid #b2d9b2' : '#fde8e8;color:#8b2020;border:1px solid #f0b0b0');
    form.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 6000);
  }

})();
