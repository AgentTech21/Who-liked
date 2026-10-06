const form = document.querySelector('#setup-form');
const libraryChoices = document.querySelector('#library-choices');
const handleCount = document.querySelector('#handle-count');
const startButton = document.querySelector('#start-button');
const errorBox = document.querySelector('#setup-error');
const intro = document.querySelector('#intro');
const game = document.querySelector('#game');
const choices = document.querySelector('#choices');
const answer = document.querySelector('#answer');
const nextButton = document.querySelector('#next-button');
const roundCount = document.querySelector('#round-count');
const poolCount = document.querySelector('#pool-count');
const scoreboard = document.querySelector('#scoreboard');
const videoFrame = document.querySelector('#video-frame');
const openTikTok = document.querySelector('#open-tiktok');

let players = [];
let repostOwners = new Map();
let current = null;
let round = 0;
let waitingForGuess = true;
let activeGuesser = null;

function getHandles() {
  return [...libraryChoices.querySelectorAll('input[name="account"]:checked')].map(input => input.value);
}

function updateHandleCount() {
  const count = getHandles().length;
  handleCount.textContent = `${count} player${count === 1 ? '' : 's'}`;
}

function renderLibraryChoices(accounts) {
  if (!accounts.length) {
    libraryChoices.innerHTML = '<p class="library-empty">No accounts loaded yet. <a href="/library.html">Load reposts into your library ↗</a></p>';
    updateHandleCount();
    return;
  }
  const playable = account => account.repostCount > 0 && account.complete;
  const defaultSelection = new Set(accounts.filter(playable).slice(0, 12).map(account => account.handle));
  libraryChoices.innerHTML = accounts.map(account => {
    const unavailable = !playable(account);
    const checked = defaultSelection.has(account.handle) ? 'checked' : '';
    const disabled = unavailable ? 'disabled' : '';
    const detail = account.repostCount === 0 ? 'No reposts found' : !account.complete ? 'Initial scan incomplete' : `${Number(account.repostCount).toLocaleString()} saved reposts`;
    return `<label class="library-choice ${unavailable ? 'unavailable' : ''}"><input type="checkbox" name="account" value="${escapeHtml(account.handle)}" ${checked} ${disabled}><span class="library-choice-name">@${escapeHtml(account.handle)}</span><span class="library-choice-detail">${detail}</span></label>`;
  }).join('');
  libraryChoices.querySelectorAll('input[name="account"]').forEach(input => input.addEventListener('change', updateHandleCount));
  updateHandleCount();
}

async function loadLibraryChoices() {
  try {
    const response = await fetch('/api/accounts');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not read the local repost library.');
    renderLibraryChoices(data.accounts || []);
  } catch (error) {
    libraryChoices.innerHTML = `<p class="library-empty">${escapeHtml(error.message)} <a href="/api/health" target="_blank" rel="noreferrer">Check server status ↗</a></p>`;
  }
}

function setError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderScoreboard() {
  scoreboard.innerHTML = [...players]
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
    .map((player, index) => `<div class="score-row"><div class="score-name"><span class="score-rank">${String(index + 1).padStart(2, '0')}</span><span>@${escapeHtml(player.handle)}</span></div><span class="score-points">${player.score}</span></div>`)
    .join('');
}

function chooseRound() {
  const poster = players[Math.floor(Math.random() * players.length)];
  const video = poster.reposts[Math.floor(Math.random() * poster.reposts.length)];
  current = { ...video, repostedBy: repostOwners.get(video.id) || [poster.handle] };
  round += 1;
  activeGuesser = players[(round - 1) % players.length];
  waitingForGuess = true;
  roundCount.textContent = `ROUND ${String(round).padStart(2, '0')}`;
  poolCount.textContent = `${players.length} PLAYERS IN POOL`;
  answer.classList.add('hidden');
  nextButton.classList.add('hidden');
  document.querySelector('#round-hint').textContent = `Pass the phone to @${activeGuesser.handle} to make the pick.`;
  openTikTok.href = `https://www.tiktok.com/@${encodeURIComponent(current.creator || '_')}/video/${current.id}`;
  videoFrame.innerHTML = `<iframe title="Mystery TikTok repost" src="https://www.tiktok.com/player/v1/${encodeURIComponent(current.id)}?controls=1&description=0&music_info=0&rel=0" allow="fullscreen; encrypted-media; picture-in-picture" allowfullscreen loading="eager"></iframe>`;
  renderChoices();
}

function renderChoices() {
  choices.innerHTML = players.map(player => `<button class="choice" type="button" data-handle="${escapeHtml(player.handle)}"><span>@${escapeHtml(player.handle)}</span><span>↗</span></button>`).join('');
  choices.querySelectorAll('.choice').forEach(button => button.addEventListener('click', () => submitGuess(button.dataset.handle, button)));
}

function submitGuess(handle, selectedButton) {
  if (!waitingForGuess) return;
  waitingForGuess = false;
  const correctHandles = current.repostedBy;
  const isCorrect = correctHandles.includes(handle);
  if (isCorrect) {
    activeGuesser.score += 1;
  }
  choices.querySelectorAll('.choice').forEach(button => {
    button.disabled = true;
    if (correctHandles.includes(button.dataset.handle)) button.classList.add('correct');
    else if (button === selectedButton && !isCorrect) button.classList.add('wrong');
  });
  document.querySelector('#round-hint').textContent = isCorrect ? `Nailed it, @${activeGuesser.handle}. Point on the board.` : 'Wrong guess. Better luck next round.';
  const repostedBy = correctHandles.map(handle => `@${escapeHtml(handle)}`).join(', ');
  answer.innerHTML = `This one was reposted by <strong>${repostedBy}</strong>.`;
  answer.classList.remove('hidden');
  nextButton.classList.remove('hidden');
  renderScoreboard();
}

loadLibraryChoices();

form.addEventListener('submit', async event => {
  event.preventDefault();
  setError('');
  const handles = getHandles();
  if (handles.length < 2) return setError('Add at least two different usernames to start.');
  if (handles.length > 12) return setError('For now, add up to 12 players.');

  startButton.disabled = true;
  startButton.querySelector('span:first-child').textContent = 'Loading saved reposts…';
  try {
    const response = await fetch('/api/game/reposts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handles })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load reposts.');
    players = (data.people || []).map(person => ({ handle: person.handle, reposts: person.reposts || [], score: 0 }));
    const emptyPlayers = players.filter(player => !player.reposts.length);
    if (emptyPlayers.length) {
      throw new Error(`Can't start until everyone has reposts. No reposts found for ${emptyPlayers.map(player => `@${player.handle}`).join(', ')}.`);
    }
    repostOwners = new Map();
    for (const player of players) {
      for (const video of player.reposts) {
        if (!repostOwners.has(video.id)) repostOwners.set(video.id, []);
        const owners = repostOwners.get(video.id);
        if (!owners.includes(player.handle)) owners.push(player.handle);
      }
    }
    if (!players.length) {
      throw new Error('TikTok returned no reposts for those profiles.');
    }
    setError('');
    intro.classList.add('hidden');
    game.classList.remove('hidden');
    renderScoreboard();
    chooseRound();
  } catch (error) {
    setError(error.message);
  } finally {
    startButton.disabled = false;
    startButton.querySelector('span:first-child').textContent = 'Start the game';
  }
});

nextButton.addEventListener('click', chooseRound);
document.querySelector('#back-button').addEventListener('click', () => {
  game.classList.add('hidden');
  intro.classList.remove('hidden');
});
document.querySelector('#reset-scores').addEventListener('click', () => {
  players.forEach(player => { player.score = 0; });
  renderScoreboard();
});
