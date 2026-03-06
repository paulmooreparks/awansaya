(function () {
  function resolveInput(button) {
    var targetId = button.getAttribute('aria-controls');
    if (targetId) {
      return document.getElementById(targetId);
    }
    var wrapper = button.closest('.password-field');
    return wrapper ? wrapper.querySelector('input') : null;
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-password-toggle]');
    if (!button) {
      return;
    }

    var input = resolveInput(button);
    if (!input) {
      return;
    }

    event.preventDefault();

    var showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? 'Show' : 'Hide';
    button.setAttribute('aria-pressed', showing ? 'false' : 'true');
  });
})();
