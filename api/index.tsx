/** @jsxImportSource frog/jsx */

import { Button, Frog } from 'frog'
import { handle } from 'frog/vercel'
import { neynar } from 'frog/middlewares'
import { NeynarVariables } from 'frog/middlewares'
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const AIRSTACK_API_URL = 'https://api.airstack.xyz/gql';
const AIRSTACK_API_KEY = process.env.AIRSTACK_API_KEY as string;
const AIRSTACK_API_KEY_SECONDARY = process.env.AIRSTACK_API_KEY_SECONDARY as string;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY as string;

// Initialize Firebase
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  }),
});

const db = getFirestore();

export const app = new Frog<{ Variables: NeynarVariables }>({
  basePath: '/api',
  imageOptions: { width: 1080, height: 1080 },
  imageAspectRatio: '1:1',
  title: 'Tic-Tac-Toe Game',
  hub: {
    apiUrl: "https://hubs.airstack.xyz",
    fetchOptions: {
      headers: {
        "x-airstack-hubs": AIRSTACK_API_KEY, 
      }
    }
  }
}).use(
  neynar({
    apiKey: NEYNAR_API_KEY, 
    features: ['interactor', 'cast'],
  })
);

const COORDINATES = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']

type GameState = {
  board: (string | null)[];
  currentPlayer: 'O' | 'X';
  isGameOver: boolean;
}

async function getUsername(fid: string): Promise<string> {
  const query = `
    query ($fid: String!) {
      Socials(input: {filter: {dappName: {_eq: farcaster}, userId: {_eq: $fid}}, blockchain: ethereum}) {
        Social {
          profileName
        }
      }
    }
  `;

  try {
    const response = await fetch(AIRSTACK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AIRSTACK_API_KEY,
      },
      body: JSON.stringify({ query, variables: { fid } }),
    });

    const data = await response.json();
    console.log('Username API response:', JSON.stringify(data));
    
    if (data?.data?.Socials?.Social?.[0]?.profileName) {
      return data.data.Socials.Social[0].profileName;
    } else {
      console.log('Unexpected API response structure:', JSON.stringify(data));
      return 'Player';
    }
  } catch (error) {
    console.error('Error fetching username:', error);
    return 'Player';
  }
}

async function getUserProfilePicture(fid: string): Promise<string | null> {
  const query = `
    query GetUserProfilePicture($fid: String!) {
      Socials(
        input: {filter: {dappName: {_eq: farcaster}, userId: {_eq: $fid}}, blockchain: ethereum}
      ) {
        Social {
          profileImage
        }
      }
    }
  `;

  try {
    const response = await fetch(AIRSTACK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AIRSTACK_API_KEY_SECONDARY,
      },
      body: JSON.stringify({ query, variables: { fid } }),
    });

    const data = await response.json();
    console.log('Profile image API response:', JSON.stringify(data));

    if (data?.data?.Socials?.Social?.[0]?.profileImage) {
      return data.data.Socials.Social[0].profileImage;
    } else {
      console.log('No profile image found or unexpected API response structure');
      return null;
    }
  } catch (error) {
    console.error('Error fetching profile image:', error);
    return null;
  }
}

async function updateUserRecord(fid: string, isWin: boolean) {
  const userRef = db.collection('users').doc(fid);
  
  await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      transaction.set(userRef, { wins: isWin ? 1 : 0, losses: isWin ? 0 : 1 });
    } else {
      const userData = userDoc.data();
      if (isWin) {
        transaction.update(userRef, { wins: (userData!.wins || 0) + 1 });
      } else {
        transaction.update(userRef, { losses: (userData!.losses || 0) + 1 });
      }
    }
  });
}

async function getUserRecord(fid: string): Promise<{ wins: number; losses: number }> {
  const userDoc = await db.collection('users').doc(fid).get();
  if (!userDoc.exists) {
    return { wins: 0, losses: 0 };
  }
  const userData = userDoc.data();
  return { wins: userData!.wins || 0, losses: userData!.losses || 0 };
}

function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}


// Initial route
app.frame('/', () => {
  const gifUrl = 'https://bafybeidnv5uh2ne54dlzyummobyv3bmc7uzuyt5htodvy27toqqhijf4xu.ipfs.w3s.link/PodPlay.gif'
  const baseUrl = 'https://podplaytest.vercel.app' // Update this to your actual Domain

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Tic-Tac-Toe Game</title>
      <meta property="fc:frame" content="vNext">
      <meta property="fc:frame:image" content="${gifUrl}">
      <meta property="fc:frame:image:aspect_ratio" content="1:1">
      <meta property="fc:frame:button:1" content="Start">
      <meta property="fc:frame:button:1:action" content="post">
      <meta property="fc:frame:post_url" content="${baseUrl}/api/howtoplay">
      
      <!-- Added Open Graph tags -->
      <meta property="og:title" content="Tic-Tac-Toe">
      <meta property="og:description" content="Start New Game or Share!">
      <meta property="og:image" content="${gifUrl}">
      <meta property="og:url" content="${baseUrl}/api">
      <meta property="og:type" content="website">
    </head>
    <body>
    </body>
    </html>
  `

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  })
})

// How to Play route
app.frame('/howtoplay', () => {
  const imageUrl = 'https://bafybeifzk7uojcicnh6yhnqvoldkpzuf32sullm34ela266xthbidca6ny.ipfs.w3s.link/HowToPlay%20(1).png'
  const baseUrl = 'https://podplaytest.vercel.app' // Update this to your actual domain

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>How to Play Tic-Tac-Toe</title>
      <meta property="fc:frame" content="vNext">
      <meta property="fc:frame:image" content="${imageUrl}">
      <meta property="fc:frame:image:aspect_ratio" content="1:1">
      <meta property="fc:frame:button:1" content="Start Game">
      <meta property="fc:frame:button:1:action" content="post">
      <meta property="fc:frame:post_url" content="${baseUrl}/api/game">
    </head>
    <body>
    </body>
    </html>
  `

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  })
})

app.frame('/game', async (c) => {
  const { buttonValue, status, frameData } = c
  const fid = frameData?.fid;

  let username = 'Player';
  if (fid) {
    try {
      username = await getUsername(fid.toString());
      console.log(`Username retrieved in /game route: ${username}`);
    } catch (error) {
      console.error('Error getting username:', error);
    }
  }

  // Always initialize a new game state when entering this route
  let state: GameState = { board: Array(9).fill(null), currentPlayer: 'O', isGameOver: false }
  let message = `New game started! Your turn, ${username}`

  if (status === 'response' && buttonValue && buttonValue.startsWith('move:')) {
    state = decodeState(buttonValue.split(':')[1])
    let { board, currentPlayer, isGameOver } = state

    const move = parseInt(buttonValue.split(':')[2])
    if (board[move] === null && !isGameOver) {
      // Player's move
      board[move] = 'O'
      message = `${username} moved at ${COORDINATES[move]}.`
      
      if (checkWin(board)) {
        message = `${username} wins! Game over.`
        isGameOver = true
        if (fid) {
          await updateUserRecord(fid.toString(), true);
        }
      } else if (board.every((cell: string | null) => cell !== null)) {
        message = "Game over! It's a draw."
        isGameOver = true
      } else {
        // Computer's move
        const computerMove = getBestMove(board, 'X')
        if (computerMove !== -1) {
          board[computerMove] = 'X'
          message += ` Computer moved at ${COORDINATES[computerMove]}.`
          
          if (checkWin(board)) {
            message += ` Computer wins! Game over.`
            isGameOver = true
            if (fid) {
              await updateUserRecord(fid.toString(), false);
            }
          } else if (board.every((cell: string | null) => cell !== null)) {
            message += " It's a draw. Game over."
            isGameOver = true
          } else {
            message += ` Your turn, ${username}.`
          }
        }
      }
    } else if (isGameOver) {
      message = "Game is over. Start a new game!"
    } else {
      message = "That spot is already taken! Choose another."
    }

    state = { board, currentPlayer, isGameOver }
  }

  // Encode the state in the button values
  const encodedState = encodeState(state)

  // Get available moves
  const availableMoves = state.board.reduce((acc, cell, index) => {
    if (cell === null) acc.push(index)
    return acc
  }, [] as number[])

  // Shuffle available moves and take the first 4 (or less if fewer are available)
  const shuffledMoves = shuffleArray([...availableMoves]).slice(0, 4)

  const intents = state.isGameOver
    ? [
        <Button value="newgame">New Game</Button>,
        <Button action={`/share?username=${encodeURIComponent(username)}`}>Share Game</Button>
      ]
    : shuffledMoves.map((index) => 
        <Button value={`move:${encodedState}:${index}`}>
          {COORDINATES[index]}
        </Button>
      )

  console.log(`Rendering /game route for username: ${username}`);
  console.log(`Game state: ${JSON.stringify(state)}`);
  console.log(`Intents: ${JSON.stringify(intents)}`);

  return c.res({
    image: (
      <div style={{
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        justifyContent: 'center',
        width: '1080px',
        height: '1080px',
        backgroundImage: 'url(https://bafybeiddxtdntzltw5xzc2zvqtotweyrgbeq7t5zvdduhi6nnb7viesov4.ipfs.w3s.link/Frame%2025%20(5).png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontSize: '36px',
        fontFamily: 'Arial, sans-serif',
      }}>
        {renderBoard(state.board)}
        <div style={{ 
          marginTop: '40px', 
          maxWidth: '900px', 
          textAlign: 'center', 
          backgroundColor: 'rgba(255, 255, 255, 0.7)', 
          padding: '20px', 
          borderRadius: '10px', 
          color: 'black' 
        }}>
          {message}
        </div>
      </div>
    ),
    intents: intents,
  })
})

app.frame('/share', async (c) => {
  const { frameData } = c;
  const fid = frameData?.fid;

  let profileImage: string | null = null;
  let userRecord = { wins: 0, losses: 0 };

  if (fid) {
    try {
      profileImage = await getUserProfilePicture(fid.toString());
      userRecord = await getUserRecord(fid.toString());
      console.log(`Profile image URL for FID ${fid}:`, profileImage);
      console.log(`User record for FID ${fid}:`, userRecord);
    } catch (error) {
      console.error(`Error fetching data for FID ${fid}:`, error);
    }
  }

  return c.res({
    image: (
      <div style={{
        display: 'flex',
        flexDirection: 'column' as const,
        justifyContent: 'center',
        alignItems: 'center',
        width: '1080px',
        height: '1080px',
        backgroundImage: 'url(https://bafybeigp3dkqr7wqgvp7wmycpg6axhgmc42pljkzmhdbnrsnxehoieqeri.ipfs.w3s.link/Frame%209.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontFamily: 'Arial, sans-serif',
      }}>
        {profileImage && (
          <img 
            src={profileImage} 
            alt="User profile"
            style={{
              width: '100px',
              height: '100px',
              borderRadius: '50%',
              border: '3px solid white',
              marginBottom: '20px',
            }}
          />
        )}
        <h1 style={{ fontSize: '48px', marginBottom: '20px' }}>Thanks for Playing!</h1>
        <p style={{ fontSize: '24px', marginBottom: '20px' }}>Your Record: {userRecord.wins}W - {userRecord.losses}L</p>
        <p style={{ fontSize: '18px', marginBottom: '20px' }}>Frame by @goldie & @themrsazon</p>
      </div>
    ),
    intents: [
      <Button action="/">Back to Game</Button>
    ],
  });
});

function renderBoard(board: (string | null)[]) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '20px',
    }}>
      {[0, 1, 2].map(row => (
        <div key={row} style={{ display: 'flex', gap: '20px' }}>
          {[0, 1, 2].map(col => {
            const index = row * 3 + col;
            return (
              <div key={index} style={{
                width: '200px',
                height: '200px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '120px',
                background: 'linear-gradient(135deg, #0F0F2F 0%, #303095 100%)',
                border: '4px solid black',
              }}>
                {board[index]}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  )
}

function getBestMove(board: (string | null)[], player: string): number {
  const opponent = player === 'X' ? 'O' : 'X'

  // Randomly choose to make a suboptimal move (started off at 30% chance)
  if (Math.random() < 0.2) {
    const availableMoves = board.reduce((acc, cell, index) => {
      if (cell === null) acc.push(index)
      return acc
    }, [] as number[])
    return availableMoves[Math.floor(Math.random() * availableMoves.length)]
  }

  // If it's the first move (only one 'O' on the board), choose a random available position
  if (board.filter(cell => cell !== null).length === 1) {
    const availableMoves = board.reduce((acc, cell, index) => {
      if (cell === null) acc.push(index)
      return acc
    }, [] as number[])
    return availableMoves[Math.floor(Math.random() * availableMoves.length)]
  }

  // Check for winning move
  for (let i = 0; i < 9; i++) {
    if (board[i] === null) {
      board[i] = player
      if (checkWin(board)) {
        board[i] = null
        return i
      }
      board[i] = null
    }
  }

  // Check for blocking opponent's winning move
  for (let i = 0; i < 9; i++) {
    if (board[i] === null) {
      board[i] = opponent
      if (checkWin(board)) {
        board[i] = null
        return i
      }
      board[i] = null
    }
  }

  // Choose center if available (70% chance)
  if (board[4] === null && Math.random() < 0.7) return 4

  // Choose corners or sides randomly
  const availableMoves = board.reduce((acc, cell, index) => {
    if (cell === null) acc.push(index)
    return acc
  }, [] as number[])
  return availableMoves[Math.floor(Math.random() * availableMoves.length)]
}

function checkWin(board: (string | null)[]) {
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
    [0, 4, 8], [2, 4, 6] // Diagonals
  ]

  return winPatterns.some(pattern =>
    board[pattern[0]] &&
    board[pattern[0]] === board[pattern[1]] &&
    board[pattern[0]] === board[pattern[2]]
  )
}

function encodeState(state: GameState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64')
}

function decodeState(encodedState: string): GameState {
  return JSON.parse(Buffer.from(encodedState, 'base64').toString())
}

export const GET = handle(app)
export const POST = handle(app)