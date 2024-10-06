/** @jsxImportSource frog/jsx */

import { Button, Frog } from 'frog'
import { handle } from 'frog/vercel'
import { neynar } from 'frog/middlewares'
import { NeynarVariables } from 'frog/middlewares'
import admin from 'firebase-admin';
import { gql, GraphQLClient } from "graphql-request";

const AIRSTACK_API_URL = 'https://api.airstack.xyz/gql';
const AIRSTACK_API_KEY = process.env.AIRSTACK_API_KEY as string;
const AIRSTACK_API_KEY_SECONDARY = process.env.AIRSTACK_API_KEY_SECONDARY as string;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY as string;
const MOXIE_API_URL = "https://api.studio.thegraph.com/query/23537/moxie_protocol_stats_mainnet/version/latest";
const MOXIE_VESTING_API_URL = "https://api.studio.thegraph.com/query/23537/moxie_vesting_mainnet/version/latest";

let db: admin.firestore.Firestore | null = null;
let initializationError: Error | null = null;

try {
  console.log('Starting Firebase initialization...');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log('Environment variables loaded:');
  console.log('Project ID:', projectId);
  console.log('Client Email:', clientEmail);
  console.log('Private Key exists:', !!privateKey);

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase configuration environment variables');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    console.log('Firebase Admin SDK initialized successfully');
  } else {
    console.log('Firebase app already initialized');
  }

  db = admin.firestore();
  console.log('Firestore instance created successfully');
} catch (error) {
  console.error('Error in Firebase initialization:', error);
  if (error instanceof Error) {
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    initializationError = error;
  }
  db = null;
}

const getDb = () => {
  if (db) {
    return db;
  }
  if (initializationError) {
    console.error('Firestore initialization failed earlier:', initializationError);
    throw initializationError;
  }
  throw new Error('Firestore is not initialized and no initialization error was caught');
};

export const app = new Frog<{ Variables: NeynarVariables }>({
  basePath: '/api',
  imageOptions: { width: 1080, height: 1080 },
  imageAspectRatio: '1:1',
  title: 'Tic-Tac-Toe Game',
  hub: {
    apiUrl: "https://hubs.airstack.xyz",
    fetchOptions: {
      headers: {
        "x-airstack-hubs": AIRSTACK_API_KEY_SECONDARY,
        "x-airstack-hubs-secondary": AIRSTACK_API_KEY
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

function calculatePODScore(wins: number, ties: number, losses: number, totalGames: number, tokenBalance: number): number {
  const baseScore = (wins * 2) + ties + (losses * 0.5);
  const gamesBonusScore = totalGames >= 25 ? 10 : 0;
  const tokenBonusScore = Math.floor(tokenBalance) * 25; // 25 points for each whole token
  const totalScore = baseScore + gamesBonusScore + tokenBonusScore;
  return Math.round(totalScore * 10) / 10; // Round to one decimal place
}


interface TokenHolding {
  balance: string;
  buyVolume: string;
  sellVolume: string;
  subjectToken: {
    name: string;
    symbol: string;
    currentPriceInMoxie: string;
  };
}

async function getFarcasterAddressesFromFID(fid: string): Promise<string[]> {
  const graphQLClient = new GraphQLClient(AIRSTACK_API_URL, {
    headers: {
      'Authorization': AIRSTACK_API_KEY,
    },
  });

  const query = gql`
    query MyQuery($identity: Identity!) {
      Socials(
        input: {
          filter: { dappName: { _eq: farcaster }, identity: { _eq: $identity } }
          blockchain: ethereum
        }
      ) {
        Social {
          userAddress
          userAssociatedAddresses
        }
      }
    }
  `;

  const variables = {
    identity: `fc_fid:${fid}`
  };

  try {
    const data = await graphQLClient.request<any>(query, variables);
    console.log('Airstack API response:', JSON.stringify(data, null, 2));

    if (!data.Socials || !data.Socials.Social || data.Socials.Social.length === 0) {
      throw new Error(`No Farcaster profile found for FID: ${fid}`);
    }

    const social = data.Socials.Social[0];
    const addresses = [social.userAddress, ...(social.userAssociatedAddresses || [])];
    return [...new Set(addresses)]; // Remove duplicates
  } catch (error) {
    console.error('Error fetching Farcaster addresses from Airstack:', error);
    throw error;
  }
}

async function getVestingContractAddress(beneficiaryAddresses: string[]): Promise<string | null> {
  const graphQLClient = new GraphQLClient(MOXIE_VESTING_API_URL);

  const query = gql`
    query MyQuery($beneficiaries: [Bytes!]) {
      tokenLockWallets(where: {beneficiary_in: $beneficiaries}) {
        address: id
        beneficiary
      }
    }
  `;

  const variables = {
    beneficiaries: beneficiaryAddresses.map(address => address.toLowerCase())
  };

  try {
    const data = await graphQLClient.request<any>(query, variables);
    console.log('Vesting contract data:', JSON.stringify(data, null, 2));

    if (data.tokenLockWallets && data.tokenLockWallets.length > 0) {
      return data.tokenLockWallets[0].address;
    } else {
      console.log(`No vesting contract found for addresses: ${beneficiaryAddresses.join(', ')}`);
      return null;
    }
  } catch (error) {
    console.error('Error fetching vesting contract address:', error);
    return null;
  }
}

async function getOwnedFanTokens(addresses: string[]): Promise<TokenHolding[] | null> {
  const graphQLClient = new GraphQLClient(MOXIE_API_URL);

  const query = gql`
    query MyQuery($userAddresses: [ID!]) {
      users(where: { id_in: $userAddresses }) {
        portfolio {
          balance
          buyVolume
          sellVolume
          subjectToken {
            name
            symbol
            currentPriceInMoxie
          }
        }
      }
    }
  `;

  const variables = {
    userAddresses: addresses.map(address => address.toLowerCase())
  };

  try {
    const data = await graphQLClient.request<any>(query, variables);
    console.log('Moxie API response for owned tokens:', JSON.stringify(data, null, 2));

    if (!data.users || data.users.length === 0) {
      console.log(`No fan tokens found for addresses: ${addresses.join(', ')}`);
      return null;
    }

    return data.users.flatMap((user: { portfolio: TokenHolding[] }) => user.portfolio);
  } catch (error) {
    console.error('Error fetching owned fan tokens from Moxie API:', error);
    return null;
  }
}

async function checkFanTokenOwnership(fid: string): Promise<{ ownsToken: boolean; balance: number }> {
  try {
    const addresses = await getFarcasterAddressesFromFID(fid);
    console.log(`Associated addresses for FID ${fid}:`, addresses);

    const vestingContractAddress = await getVestingContractAddress(addresses);
    if (vestingContractAddress) {
      addresses.push(vestingContractAddress);
      console.log(`Added vesting contract address:`, vestingContractAddress);
    }

    const ownedTokens = await getOwnedFanTokens(addresses);
    if (!ownedTokens) {
      return { ownsToken: false, balance: 0 };
    }

    const thepodToken = ownedTokens.find(token => 
      token.subjectToken.symbol.toLowerCase() === "cid:thepod"
    );

    if (thepodToken && parseFloat(thepodToken.balance) > 0) {
      const formattedBalance = parseFloat(thepodToken.balance) / 1e18; // Convert from wei to whole tokens
      console.log(`User owns ${formattedBalance} of the thepod token`);
      return { ownsToken: true, balance: formattedBalance };
    } else {
      console.log(`User does not own any thepod tokens`);
      return { ownsToken: false, balance: 0 };
    }
  } catch (error) {
    console.error('Error in checkFanTokenOwnership:', error);
    return { ownsToken: false, balance: 0 };
  }
}




async function getTotalGamesPlayed(fid: string): Promise<number> {
  console.log(`Attempting to get total games played for FID: ${fid}`);
  try {
    const database = getDb();
    const userDoc = await database.collection('users').doc(fid).get();
    if (!userDoc.exists) {
      console.log(`No record found for FID: ${fid}. Returning 0 total games.`);
      return 0;
    }
    const userData = userDoc.data();
    const wins = userData?.wins || 0;
    const losses = userData?.losses || 0;
    const ties = userData?.ties || 0;
    const totalGames = wins + losses + ties;
    console.log(`Total games played for FID ${fid}:`, totalGames);
    return totalGames;
  } catch (error) {
    console.error(`Error getting total games played for FID ${fid}:`, error);
    return 0;
  }
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

async function updateUserTie(fid: string) {
  console.log(`Attempting to update tie for FID: ${fid}`);
  try {
    const database = getDb();
    const userRef = database.collection('users').doc(fid);
    await userRef.set({
      ties: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    console.log(`User tie updated successfully for FID: ${fid}`);
  } catch (error) {
    console.error(`Error updating user tie for FID ${fid}:`, error);
  }
}

async function updateUserTieAsync(fid: string) {
  try {
    await updateUserTie(fid);
    console.log(`User tie updated asynchronously for FID: ${fid}`);
  } catch (error) {
    console.error(`Error updating user tie asynchronously for FID ${fid}:`, error);
  }
}

async function getUserRecord(fid: string): Promise<{ wins: number; losses: number; ties: number }> {
  console.log(`Attempting to get user record for FID: ${fid}`);
  try {
    const database = getDb();
    const userDoc = await database.collection('users').doc(fid).get();
    if (!userDoc.exists) {
      console.log(`No record found for FID: ${fid}. Returning default record.`);
      return { wins: 0, losses: 0, ties: 0 };
    }
    const userData = userDoc.data();
    console.log(`User data for FID ${fid}:`, userData);
    return { 
      wins: userData?.wins || 0, 
      losses: userData?.losses || 0,
      ties: userData?.ties || 0
    };
  } catch (error) {
    console.error(`Error getting user record for FID ${fid}:`, error);
    // Return default record in case of error
    return { wins: 0, losses: 0, ties: 0 };
  }
}

async function updateUserRecord(fid: string, isWin: boolean) {
  console.log(`Attempting to update user record for FID: ${fid}, isWin: ${isWin}`);
  try {
    const database = getDb();
    const userRef = database.collection('users').doc(fid);
    await userRef.set({
      [isWin ? 'wins' : 'losses']: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    console.log(`User record updated successfully for FID: ${fid}`);
  } catch (error) {
    console.error(`Error updating user record for FID ${fid}:`, error);
  }
}

async function updateUserRecordAsync(fid: string, isWin: boolean) {
  try {
    await updateUserRecord(fid, isWin);
    console.log(`User record updated asynchronously for FID: ${fid}`);
  } catch (error) {
    console.error(`Error updating user record asynchronously for FID ${fid}:`, error);
  }
}

function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getBestMove(board: (string | null)[], player: string): number {
  const opponent = player === 'X' ? 'O' : 'X'

  if (Math.random() < 0.2) {
    const availableMoves = board.reduce((acc, cell, index) => {
      if (cell === null) acc.push(index)
      return acc
    }, [] as number[])
    return availableMoves[Math.floor(Math.random() * availableMoves.length)]
  }

  if (board.filter(cell => cell !== null).length === 1) {
    const availableMoves = board.reduce((acc, cell, index) => {
      if (cell === null) acc.push(index)
      return acc
    }, [] as number[])
    return availableMoves[Math.floor(Math.random() * availableMoves.length)]
  }

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

  if (board[4] === null && Math.random() < 0.7) return 4

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
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

function decodeState(encodedState: string): GameState {
  return JSON.parse(Buffer.from(encodedState, 'base64').toString());
}

function renderBoard(board: (string | null)[]) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
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

// Routes will be defined here...

// Initial route
app.frame('/', () => {
  const gifUrl = 'https://bafybeidnv5uh2ne54dlzyummobyv3bmc7uzuyt5htodvy27toqqhijf4xu.ipfs.w3s.link/PodPlay.gif'
  const baseUrl = 'https://podplay.vercel.app' // Update this to your actual Domain

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
  const baseUrl = 'https://podplay.vercel.app' // Update this to your actual domain

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
  console.log('Entering /game route');
  const { buttonValue, status, frameData } = c;
  console.log('Request details:', { buttonValue, status, frameData });
  const fid = frameData?.fid;

  let username = 'Player';
  if (fid) {
    try {
      username = await getUsername(fid.toString());
      console.log(`Username fetched: ${username}`);
    } catch (error) {
      console.error('Error getting username:', error);
    }
  }

  let state: GameState = { board: Array(9).fill(null), currentPlayer: 'O', isGameOver: false };
  let message = `New game started! Your turn, ${username}`;

  if (status === 'response' && buttonValue && buttonValue.startsWith('move:')) {
    console.log('Processing move');
    try {
      const [, encodedState, moveIndex] = buttonValue.split(':');
      state = decodeState(encodedState);
      const move = parseInt(moveIndex);
      console.log('Move details:', { move, currentBoard: state.board });

      if (state.board[move] === null && !state.isGameOver) {
        state.board[move] = 'O';
        message = `${username} moved at ${COORDINATES[move]}.`;
        
        if (checkWin(state.board)) {
          message = `${username} wins! Game over.`;
          state.isGameOver = true;
          if (fid) {
            updateUserRecordAsync(fid.toString(), true);
          }
        } else if (state.board.every((cell) => cell !== null)) {
          message = "Game over! It's a Tie.";
          state.isGameOver = true;
          if (fid) {
            updateUserTieAsync(fid.toString());
          }
        } else {
          const computerMove = getBestMove(state.board, 'X');
          state.board[computerMove] = 'X';
          message += ` Computer moved at ${COORDINATES[computerMove]}.`;
          
          if (checkWin(state.board)) {
            message += ` Computer wins! Game over.`;
            state.isGameOver = true;
            if (fid) {
              updateUserRecordAsync(fid.toString(), false);
            }
          } else if (state.board.every((cell) => cell !== null)) {
            message += " It's a draw. Game over.";
            state.isGameOver = true;
            if (fid) {
              updateUserTieAsync(fid.toString());
            }
          } else {
            message += ` Your turn, ${username}.`;
          }
        }
      } else if (state.isGameOver) {
        message = "Game is over. Start a new game!";
      } else {
        message = "That spot is already taken! Choose another.";
      }
    } catch (error) {
      console.error('Error processing move:', error);
      message = "An error occurred while processing your move. Please try again.";
    }
  }

  console.log('Final game state:', state);
  console.log('Message:', message);

  const encodedState = encodeState(state);
  const availableMoves = state.board.reduce((acc, cell, index) => {
    if (cell === null) acc.push(index);
    return acc;
  }, [] as number[]);

  const shuffledMoves = shuffleArray(availableMoves).slice(0, 4);

  const intents = state.isGameOver
    ? [
        <Button value="newgame">New Game</Button>,
        <Button action="/share">Your Stats</Button>
      ]
    : shuffledMoves.map((index) => 
        <Button value={`move:${encodedState}:${index}`}>
          {COORDINATES[index]}
        </Button>
      );

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
  });
});


app.frame('/share', async (c) => {
  console.log('Entering /share route');
  const { frameData } = c;
  const fid = frameData?.fid;
  const shareText = 'Welcome to POD Play presented by /thepod 🕹️. Think you can win a game of Tic-Tac-Toe? Frame by @goldie & @themrsazon';
  const baseUrl = 'https://podplay.vercel.app'; // Update this to your actual domain
  const originalFramesLink = `${baseUrl}/api`;
  
  const farcasterShareURL = `https://warpcast.com/~/compose?text=${encodeURIComponent(shareText)}&embeds[]=${encodeURIComponent(originalFramesLink)}`;

  let profileImage: string | null = null;
  let userRecord = { wins: 0, losses: 0, ties: 0 };
  let totalGamesPlayed = 0;
  let podScore = 0;
  let ownsThepodToken = false;
  let thepodTokenBalance = 0;

  if (fid) {
    try {
      const [profileImageResult, userRecordResult, totalGamesResult, fanTokenResult] = await Promise.all([
        getUserProfilePicture(fid.toString()),
        getUserRecord(fid.toString()),
        getTotalGamesPlayed(fid.toString()),
        checkFanTokenOwnership(fid.toString())
      ]);

      profileImage = profileImageResult;
      userRecord = userRecordResult;
      totalGamesPlayed = totalGamesResult;
      ownsThepodToken = fanTokenResult.ownsToken;
      thepodTokenBalance = fanTokenResult.balance;
      podScore = calculatePODScore(userRecord.wins, userRecord.ties, userRecord.losses, totalGamesPlayed, thepodTokenBalance);

      console.log(`Profile image URL for FID ${fid}:`, profileImage);
      console.log(`User record for FID ${fid}:`, userRecord);
      console.log(`Total games played for FID ${fid}:`, totalGamesPlayed);
      console.log(`POD Score for FID ${fid}:`, podScore);
      console.log(`Owns 'thepod' fan token for FID ${fid}:`, ownsThepodToken);
      console.log(`'thepod' fan token balance for FID ${fid}:`, thepodTokenBalance);
    } catch (error) {
      console.error(`Error fetching data for FID ${fid}:`, error);
      if (error instanceof Error) {
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
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
              width: '250px',
              height: '250px',
              borderRadius: '50%',
              border: '3px solid white',
              marginBottom: '20px',
            }}
          />
        )}
        <h1 style={{ fontSize: '60px', marginBottom: '20px' }}>Thanks for Playing!</h1>
        <p style={{ fontSize: '46px', marginBottom: '20px' }}>Your Record: {userRecord.wins}W - {userRecord.losses}L - {userRecord.ties}T</p>
        <p style={{ fontSize: '42px', marginBottom: '20px' }}>POD Score: {podScore}</p>
        <p style={{ fontSize: '38px', marginBottom: '20px' }}>Total Games Played: {totalGamesPlayed}</p>
        <p style={{ fontSize: '34px', marginBottom: '20px' }}>
          {ownsThepodToken ? `You hold ${thepodTokenBalance.toFixed(2)} /thepod Fan tokens 🐳!` : 'Get some /thepod Fan Tokens for more points!'}
        </p>
        <p style={{ fontSize: '28px', marginBottom: '20px' }}>Frame by @goldie & @themrsazon</p>
      </div>
    ),
    intents: [
      <Button action="/game">Play Again</Button>,
      <Button.Link href="https://moxie-frames.airstack.xyz/stim?t=cid_thepod">POD FT</Button.Link>,
      <Button.Link href={farcasterShareURL}>Share Game</Button.Link>
    ],
  });
});


export const GET = handle(app)
export const POST = handle(app)
