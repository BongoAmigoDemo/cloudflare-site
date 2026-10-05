const button = document.getElementById('myButton');
const message = document.getElementById('message');

let clickCount = 0;

button.addEventListener('click', () => {
  clickCount++;
  message.textContent = `You clicked ${clickCount} time${clickCount > 1 ? 's' : ''}! 🎉`;
});