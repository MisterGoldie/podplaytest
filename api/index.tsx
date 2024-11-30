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
const MOXIE_VESTING_API_URL = "https://api.studio.thegraph.com/query/23537/moxie_vesting_mainnet/version/latest";
const MOXIE_API_URL = "https://api.studio.thegraph.com/query/23537/moxie_protocol_stats_mainnet/version/latest";
const WIN_GIF_URL = 'https://bafybeie6qqm6r24chds5smesevkrdsg3jqmgw5wdmwzat7zdze3ukcgd5m.ipfs.w3s.link/giphy-downsized%202.GIF'
const LOSE_GIF_URL = 'https://bafybeighyzexsg3vjxli5o6yfxfxuwrwsjoljnruvwhpqklqdyddpsxxry.ipfs.w3s.link/giphy%202.GIF'
const DRAW_GIF_URL = 'https://bafybeigniqc263vmmcwmy2l4hitkklyarbu2e6s3q46izzalxswe5wbyaa.ipfs.w3s.link/giphy.GIF'

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
  imageOptions: {
    width: 1080,
    height: 1080,
    fonts: [
      {
        name: 'Silkscreen',
        source: 'google',
        weight: 400,
      },
      {
        name: 'Silkscreen',
        source: 'google',
        weight: 700,
      },
    ],
  },
  imageAspectRatio: '1:1',
  title: 'Tic-Tac-Maxi Game',
  hub: {
    apiUrl: "https://hubs.airstack.xyz",
    fetchOptions: {
      headers: {
        "x-airstack-hubs": AIRSTACK_API_KEY,
        "x-airstack-hubs-secondary": AIRSTACK_API_KEY_SECONDARY
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
  difficulty: 'easy' | 'medium' | 'hard';
}

function calculatePODScore(wins: number, ties: number, losses: number, totalGames: number, tokenBalance: number): number {
  // Base score calculation
  const baseScore = (wins * 2) + ties + (losses * 0.5);
  
  // Games bonus: +10 points for every 25 games played
  const gamesBonus = Math.floor(totalGames / 25) * 10;
  
  // Token bonus: +25 points PER /thepod fan token owned
  const tokenBonus = tokenBalance * 25;
  
  // Calculate total score
  const totalScore = baseScore + gamesBonus + tokenBonus;
  
  // Round to one decimal place
  return Math.round(totalScore * 10) / 10;
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

// Add delay between API calls
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Use it in getOwnedFanTokens
async function getOwnedFanTokens(addresses: string[]): Promise<TokenHolding[] | null> {
  const graphQLClient = new GraphQLClient(MOXIE_API_URL)
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
  `

  try {
    const data = await graphQLClient.request<any>(query, {
      userAddresses: addresses.map(address => address.toLowerCase())
    });
    
    console.log('Moxie API Response:', JSON.stringify(data, null, 2));
    
    return data.users?.[0]?.portfolio || null;
  } catch (error) {
    console.error('Error fetching fan tokens:', error);
    return null;
  }
}

async function checkFanTokenOwnership(fid: string): Promise<{ ownsToken: boolean; balance: number }> {
  try {
    const addresses = await getFarcasterAddressesFromFID(fid);
    console.log('Found addresses:', addresses);

    if (!addresses || addresses.length === 0) {
      return { ownsToken: false, balance: 0 };
    }

    // Get vesting contract address if it exists
    const vestingAddress = await getVestingContractAddress(addresses);
    if (vestingAddress) {
      addresses.push(vestingAddress);
    }

    const fanTokenData = await getOwnedFanTokens(addresses);
    console.log('Fan token data:', fanTokenData);

    if (!fanTokenData) {
      return { ownsToken: false, balance: 0 };
    }

    // Fix: Correctly find the thepod token
    const thepodToken = fanTokenData.find((token: TokenHolding) => 
      token.subjectToken.symbol.toLowerCase() === "cid:thepod"
    );

    console.log('Found thepod token:', thepodToken);

    if (thepodToken && parseFloat(thepodToken.balance) > 0) {
      const balance = parseFloat(thepodToken.balance) / 1e18; // Convert from wei
      console.log('Calculated balance:', balance);
      return { ownsToken: true, balance };
    }

    return { ownsToken: false, balance: 0 };
  } catch (error) {
    console.error('Error checking fan token ownership:', error);
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
      let profileImage = data.data.Socials.Social[0].profileImage;
      // Extract the original Imgur URL
      const imgurMatch = profileImage.match(/https:\/\/i\.imgur\.com\/[^.]+\.[a-zA-Z]+/);
      if (imgurMatch) {
        profileImage = imgurMatch[0];
      }
      console.log('Extracted profile image URL:', profileImage);
      return profileImage;
    } else {
      console.log('No profile image found or unexpected API response structure');
      return null;
    }
  } catch (error) {
    console.error('Error fetching profile image:', error);
    return null;
  }
}

// Update the updateUserTie function to include difficulty
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

// Update UserRecord type to include profile image
type UserRecord = {
  wins: number;
  losses: number;
  ties: number;
  easyWins: number;
  mediumWins: number;
  hardWins: number;
  timestamp: admin.firestore.Timestamp;
  profileImage?: string;  // Added this field
}

// When updating user record, also store their profile image
async function updateUserRecord(fid: string, isWin: boolean, difficulty: 'easy' | 'medium' | 'hard') {
  try {
    const database = getDb();
    const userRef = database.collection('users').doc(fid);
    
    // Get profile image
    const profileImage = await getUserProfilePicture(fid);
    
    const update: any = {
      [isWin ? 'wins' : 'losses']: admin.firestore.FieldValue.increment(1),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      profileImage: profileImage  // Store profile image URL
    };
    
    if (isWin) {
      update[`${difficulty}Wins`] = admin.firestore.FieldValue.increment(1);
    }
    
    await userRef.set(update, { merge: true });
  } catch (error) {
    console.error(`Error updating user record for FID ${fid}:`, error);
  }
}

// Function to get recent players with their profile images
async function getRecentPlayers(limit: number = 8): Promise<Array<{fid: string, profileImage: string | null}>> {
  try {
    const database = getDb();
    const usersSnapshot = await database.collection('users')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const playerPromises = usersSnapshot.docs.map(async (doc) => {
      const fid = doc.id;
      // Fetch profile image directly from Airstack instead of using stored data
      const profileImage = await getUserProfilePicture(fid);
      return { fid, profileImage };
    });

    const players = await Promise.all(playerPromises);
    return players.filter(player => player.profileImage !== null);
  } catch (error) {
    console.error('Error getting recent players:', error);
    return [];
  }
}

async function getTotalPlayers(): Promise<number> {
  try {
    const database = getDb();
    const snapshot = await database.collection('users').count().get();
    return snapshot.data().count;
  } catch (error) {
    console.error('Error getting total player count:', error);
    return 0;
  }
}

// Update the initial routes
app.frame('/', async (c) => {
  const gifUrl = 'https://bafybeidnv5uh2ne54dlzyummobyv3bmc7uzuyt5htodvy27toqqhijf4xu.ipfs.w3s.link/PodPlay.gif';
  const baseUrl = 'https://podplay.vercel.app';

  // Get total players
  const totalPlayers = await getTotalPlayers();
  
  // Get both profile images
  const [profileImage1, profileImage2] = await Promise.all([
    getUserProfilePicture('7472'),
    getUserProfilePicture('14871')
  ]);

  // Subtract 2 from totalPlayers since we're showing those two separately
  const displayTotal = totalPlayers - 2;

  return c.res({
    image: (
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        width: '1080px',
        height: '1080px',
        backgroundImage: `url(${gifUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        paddingBottom: '100px'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          background: 'white',
          padding: '15px 25px',
          borderRadius: '12px',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
          }}>
            <img 
              src={profileImage1 || ''}
              alt=""
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                border: '2px solid white',
                zIndex: 2
              }}
            />
            <img 
              src={profileImage2 || ''}
              alt=""
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                border: '2px solid white',
                marginLeft: '-12px',
                zIndex: 1
              }}
            />
          </div>
          <span style={{ 
            fontSize: '24px', 
            color: '#666'
          }}>
            +{displayTotal} players have enjoyed the game
          </span>
        </div>
      </div>
    ),
    intents: [
      <Button action="/howtoplay">Start Game</Button>
    ]
  });
});

function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Add this function before the app.frame('/game', ...) definition

function checkWin(board: (string | null)[]): boolean {
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
    [0, 4, 8], [2, 4, 6] // Diagonals
  ];

  return winPatterns.some(pattern =>
    board[pattern[0]] &&
    board[pattern[0]] === board[pattern[1]] &&
    board[pattern[0]] === board[pattern[2]]
  );
}

// Update the getBestMove function to use checkWin
function getBestMove(board: (string | null)[], player: string): number {
  const opponent = player === 'X' ? 'O' : 'X';

  if (Math.random() < 0.2) {
    const availableMoves = board.reduce((acc, cell, index) => {
      if (cell === null) acc.push(index);
      return acc;
    }, [] as number[]);
    return availableMoves[Math.floor(Math.random() * availableMoves.length)];
  }

  if (board.filter(cell => cell !== null).length === 1) {
    const availableMoves = board.reduce((acc, cell, index) => {
      if (cell === null) acc.push(index);
      return acc;
    }, [] as number[]);
    return availableMoves[Math.floor(Math.random() * availableMoves.length)];
  }

  for (let i = 0; i < 9; i++) {
    if (board[i] === null) {
      board[i] = player;
      if (checkWin(board)) {
        board[i] = null;
        return i;
      }
      board[i] = null;
    }
  }

  for (let i = 0; i < 9; i++) {
    if (board[i] === null) {
      board[i] = opponent;
      if (checkWin(board)) {
        board[i] = null;
        return i;
      }
      board[i] = null;
    }
  }

  if (board[4] === null && Math.random() < 0.7) return 4;

  const availableMoves = board.reduce((acc, cell, index) => {
    if (cell === null) acc.push(index);
    return acc;
  }, [] as number[]);
  return availableMoves[Math.floor(Math.random() * availableMoves.length)];
}

function encodeState(state: GameState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

function decodeState(encodedState: string): GameState {
  const decoded = JSON.parse(Buffer.from(encodedState, 'base64').toString());
  // Ensure difficulty exists in decoded state
  return {
    ...decoded,
    difficulty: decoded.difficulty || 'medium' // Default to medium if not specified
  };
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

// Add this function before the game route
function getCPUMove(board: (string | null)[], difficulty: 'easy' | 'medium' | 'hard'): number {
  // Easy mode: Mostly random moves with occasional blocking
  if (difficulty === 'easy') {
    if (Math.random() < 0.5) {
      const availableMoves = board.reduce((acc, cell, index) => {
        if (cell === null) acc.push(index);
        return acc;
      }, [] as number[]);
      return availableMoves[Math.floor(Math.random() * availableMoves.length)];
    }
  }

  // Medium mode: Mix of random and strategic moves
  if (difficulty === 'medium') {
    if (Math.random() < 0.3) {
      const availableMoves = board.reduce((acc, cell, index) => {
        if (cell === null) acc.push(index);
        return acc;
      }, [] as number[]);
      return availableMoves[Math.floor(Math.random() * availableMoves.length)];
    }
  }

  // Hard mode (or fallback for medium): Use getBestMove
  return getBestMove(board, 'X');
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
      <title>Tic-Tac-Maxi Game</title>
      <meta property="fc:frame" content="vNext">
      <meta property="fc:frame:image" content="${gifUrl}">
      <meta property="fc:frame:image:aspect_ratio" content="1:1">
      <meta property="fc:frame:button:1" content="Start">
      <meta property="fc:frame:button:1:action" content="post">
      <meta property="fc:frame:post_url" content="${baseUrl}/api/howtoplay">
      
      
      <!-- Added Open Graph tags -->
      <meta property="og:title" content="Tic-Tac-Maxi">
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

app.frame('/howtoplay', () => {
  const imageUrl = 'https://bafybeifzk7uojcicnh6yhnqvoldkpzuf32sullm34ela266xthbidca6ny.ipfs.w3s.link/HowToPlay%20(1).png'

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>How to Play Tic-Tac-Maxi</title>
      <meta property="fc:frame" content="vNext">
      <meta property="fc:frame:image" content="${imageUrl}">
      <meta property="fc:frame:image:aspect_ratio" content="1:1">
      <meta property="fc:frame:button:1" content="Choose Difficulty">
      <meta property="fc:frame:button:1:action" content="post">
      <meta property="fc:frame:post_url" content="https://podplay.vercel.app/api/difficulty">
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
app.frame('/difficulty', (c) => {
  return c.res({
    image: (
      <div style={{
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        justifyContent: 'center',
        width: '1080px',
        height: '1080px',
        backgroundImage: 'url(https://bafybeic3qu53tn46qmtgvterldnbbavt2h5y2x7unpyyc7txh2kcx6f6jm.ipfs.w3s.link/Frame%2039%20(3).png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontFamily: 'Arial, sans-serif',
      }}>
        <h1 style={{ fontSize: '52px', marginBottom: '20px' }}>Select Difficulty</h1>
        <div style={{
          display: 'flex',
          flexDirection: 'column' as const,
          gap: '20px',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          padding: '40px',
          borderRadius: '10px',
          width: '80%',
          alignItems: 'center',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: '44px', textAlign: 'center' }}>Choose your difficulty:</p>
          <p style={{ fontSize: '36px', marginBottom: '10px', textAlign: 'center' }}>🟢 Easy: For casual fun</p>
          <p style={{ fontSize: '36px', marginBottom: '10px', textAlign: 'center' }}>🟡 Medium: For a challenge</p>
          <p style={{ fontSize: '36px', marginBottom: '10px', textAlign: 'center' }}>🔴 Hard: For experts</p>
        </div>
      </div>
    ),
    intents: [
      <Button action="/game" value="start:easy">Easy 🟢</Button>,
      <Button action="/game" value="start:medium">Medium 🟡</Button>,
      <Button action="/game" value="start:hard">Hard 🔴</Button>
    ],
  });
});

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

  let state: GameState = {
    board: Array(9).fill(null), currentPlayer: 'O', isGameOver: false,
    difficulty: 'easy' // Default difficulty
  };
  
  // Set difficulty based on buttonValue if starting a new game
  if (status === 'response' && buttonValue && buttonValue.startsWith('start:')) {
    const [, difficulty] = buttonValue.split(':');
    state.difficulty = difficulty as 'easy' | 'medium' | 'hard';
  }
  
  let message = `New game started on ${state.difficulty}! Your turn, ${username}`;
  let gameResult: 'win' | 'lose' | 'draw' | null = null;

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
          gameResult = 'win';
          message = `${username} wins! Game over.`;
          state.isGameOver = true;
          if (fid) {
            updateUserRecord(fid.toString(), true, state.difficulty);
          }
        } else if (state.board.every((cell) => cell !== null)) {
          gameResult = 'draw';
          message = `It's a draw! Game over.`;
          state.isGameOver = true;
          if (fid) {
            updateUserTieAsync(fid.toString());
          }
        } else {
          const computerMove = getCPUMove(state.board, state.difficulty);
          state.board[computerMove] = 'X';
          message += ` Computer moved at ${COORDINATES[computerMove]}.`;
          
          if (checkWin(state.board)) {
            gameResult = 'lose';
            message = `Computer wins! Game over.`;
            state.isGameOver = true;
            if (fid) {
              updateUserRecord(fid.toString(), false, state.difficulty);
            }
          } else if (state.board.every((cell) => cell !== null)) {
            gameResult = 'draw';
            message += ` It's a draw. Game over.`;
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
  console.log('Game result:', gameResult);

  const encodedState = encodeState(state);
  const availableMoves = state.board.reduce((acc, cell, index) => {
    if (cell === null) acc.push(index);
    return acc;
  }, [] as number[]);

  const shuffledMoves = shuffleArray(availableMoves).slice(0, 4);

  const intents = state.isGameOver
    ? [
        <Button action="/difficulty">Play Again</Button>,
        <Button action="/share">Your Stats</Button>,
        <Button action="https://moxie-frames.airstack.xyz/stim?t=cid_thepod">/thepod FT</Button>,
        <Button.Link href={`https://warpcast.com/~/compose?text=${encodeURIComponent(`I just played Tic-Tac-Maxi by POD Play presented by @moxie.eth! ${
          gameResult === 'win' 
            ? 'I won! 😁' 
            : gameResult === 'lose'
            ? 'I lost 😔'
            : gameResult === 'draw'
            ? "It's a draw!"
            : ''
        } Frame by @goldie & @themrsazon`)}&embeds[]=${encodeURIComponent(`https://podplay.vercel.app/api/shared-game?state=${encodedState}&result=${gameResult}`)}`}>
          Share Results
        </Button.Link>
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
        backgroundImage: 'url(https://bafybeidmy2f6x42tjkgtrsptnntcjulfehlvt3ddjoyjbieaz7sywohpxy.ipfs.w3s.link/Frame%2039%20(1).png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontSize: '36px',
        fontFamily: '"Silkscreen", sans-serif',
      }}>
        {renderBoard(state.board)}
        <div style={{ 
          marginTop: '40px', 
          maxWidth: '900px', 
          textAlign: 'center', 
          backgroundColor: 'rgba(255, 255, 255, 0.7)', 
          padding: '20px', 
          borderRadius: '10px', 
          color: 'black',
          fontFamily: '"Silkscreen", sans-serif',
          fontWeight: 700,
        }}>
          {message}
        </div>
      </div>
    ),
    intents: intents,
  });
});

// Update the /next routes
app.frame('/next', (c) => {
  const result = c.req.query('result');
  console.log('Received result:', result);
  console.log('Full query string:', c.req.url.search);

  let gifUrl;

  switch (result) {
    case 'win':
      gifUrl = WIN_GIF_URL;
      console.log('Selected win GIF');
      break;
    case 'lose':
      gifUrl = LOSE_GIF_URL;
      console.log('Selected lose GIF');
      break;
    case 'draw':
      gifUrl = DRAW_GIF_URL;
      console.log('Selected draw GIF');
      break;
    default:
      gifUrl = WIN_GIF_URL;
      console.log('Default to draw GIF. Unexpected result:', result);
  }

  console.log('Final GIF URL:', gifUrl);

  const baseUrl = 'https://podplay.vercel.app';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Game Result: ${result}</title>
      <meta property="fc:frame" content="vNext">
      <meta property="fc:frame:image" content="${gifUrl}">
      <meta property="fc:frame:image:aspect_ratio" content="1:1">
      <meta property="fc:frame:button:1" content="New Game">
      <meta property="fc:frame:button:2" content="Your Stats">
      <meta property="fc:frame:button:1:action" content="post">
      <meta property="fc:frame:button:2:action" content="post">
      <meta property="fc:frame:post_url" content="${baseUrl}/api/next">
      <meta property="fc:frame:button:1:target" content="${baseUrl}/api/game">
      <meta property="fc:frame:button:2:target" content="${baseUrl}/api/share">
    </head>
    <body>
      <h1>Game Result: ${result}</h1>
    </body>
    </html>
  `;

  console.log('Generated HTML:', html);

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
});

// Add this function to get user record
async function getUserRecord(fid: string): Promise<UserRecord> {
  try {
    const database = getDb();
    const userDoc = await database.collection('users').doc(fid).get();
    if (!userDoc.exists) {
      return { wins: 0, losses: 0, ties: 0, easyWins: 0, mediumWins: 0, hardWins: 0, timestamp: admin.firestore.Timestamp.fromDate(new Date()) };
    }
    return userDoc.data() as UserRecord;
  } catch (error) {
    console.error(`Error getting user record for FID ${fid}:`, error);
    return { wins: 0, losses: 0, ties: 0, easyWins: 0, mediumWins: 0, hardWins: 0, timestamp: admin.firestore.Timestamp.fromDate(new Date()) };
  }
}

// Then update the /share route to use getUserRecord instead of userRecord
app.frame('/share', async (c) => {
  console.log('Entering /share route');
  const { frameData } = c;
  const fid = frameData?.fid;
  const result = c.req.query('result');
  const state = c.req.query('state');

  let profileImage: string | null = null;
  let userRecord = { wins: 0, losses: 0, ties: 0 };
  let totalGamesPlayed = 0;
  let podScore = 0;
  let ownsThepodToken = false;
  let thepodTokenBalance = 0;
  let username = 'Player';

  if (fid) {
    try {
      const [profileImageResult, userRecordResult, totalGamesResult, fanTokenResult, usernameResult] = await Promise.all([
        getUserProfilePicture(fid.toString()),
        getUserRecord(fid.toString()),
        getTotalGamesPlayed(fid.toString()),
        checkFanTokenOwnership(fid.toString()),
        getUsername(fid.toString())
      ]);

      profileImage = profileImageResult;
      userRecord = userRecordResult;
      totalGamesPlayed = totalGamesResult;
      ownsThepodToken = fanTokenResult.ownsToken;
      thepodTokenBalance = fanTokenResult.balance;
      username = usernameResult;
      podScore = calculatePODScore(userRecord.wins, userRecord.ties, userRecord.losses, totalGamesPlayed, thepodTokenBalance);

      console.log(`Profile image URL for FID ${fid}:`, profileImage);
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
        backgroundImage: 'url(https://bafybeiax2usqi6g7cglrvxa5n3vw7vimqruklebxnmmpm5bo7ah4yldhwi.ipfs.w3s.link/Frame%2039%20(2).png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontFamily: 'Arial, sans-serif',
      }}>
        {profileImage ? (
          <img 
            src={profileImage} 
            alt="User profile"
            width={200}
            height={200}
            style={{
              borderRadius: '50%',
              border: '3px solid white',
              marginBottom: '20px',
              objectFit: 'cover',
            }}
          />
        ) : (
          <div style={{
            width: '200px',
            height: '200px',
            borderRadius: '50%',
            border: '3px solid white',
            marginBottom: '20px',
            backgroundColor: '#303095',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '72px',
            color: 'white',
          }}>
            {fid ? fid.toString().slice(0, 2) : 'P'}
          </div>
        )}
        <h1 style={{ fontSize: '52px', marginBottom: '20px' }}>{username}'s Stats</h1>
        <div style={{
          display: 'flex',
          flexDirection: 'column' as const,
          alignItems: 'flex-start',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          padding: '20px',
          borderRadius: '10px',
          width: '80%',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>POD Score:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{podScore}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>Record:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{userRecord.wins}W - {userRecord.losses}L - {userRecord.ties}T</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>Total Games Played:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{totalGamesPlayed}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>/thepod Fan Tokens owned:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{thepodTokenBalance.toFixed(2)}</span>
          </div>
        </div>
        <p style={{ fontSize: '28px', marginTop: '20px' }}>Frame by @goldie & @themrsazon</p>
      </div>
    ),
    intents: [
      <Button action="/difficulty">Play Again</Button>,
      <Button action="https://moxie-frames.airstack.xyz/stim?t=cid_thepod">/thepod FT</Button>,
      <Button.Link href={`https://warpcast.com/~/compose?text=${encodeURIComponent(`I just played Tic-Tac-Maxi and my POD Score is ${podScore.toFixed(1)} 🕹️. Keep playing to increase your POD Score! Frame by @goldie & @themrsazon. Powered by @moxie.eth`)}&embeds[]=${encodeURIComponent(`https://podplay.vercel.app/api/shared-stats?wins=${userRecord.wins}&losses=${userRecord.losses}&ties=${userRecord.ties}&games=${totalGamesPlayed}&tokens=${thepodTokenBalance}&score=${podScore}&username=${encodeURIComponent(username)}`)}`}>
        Share Stats
      </Button.Link>,
      <Button.Link href={`https://warpcast.com/~/compose?text=${encodeURIComponent('Play Tic-Tac-Maxi by POD Play presented by @moxie.eth! Frame by @goldie & @themrsazon')}&embeds[]=${encodeURIComponent('https://podplay.vercel.app/api')}`}>
        Share Game
      </Button.Link>
    ],
  });
});


app.frame('/shared-stats', async (c) => {
  const { wins, losses, ties, games, tokens, score, username } = c.req.query();
  
  // Fetch the profile image
  let profileImage: string | null = null;
  try {
    profileImage = await getUserProfilePicture(username as string);
  } catch (error) {
    console.error('Error fetching profile image:', error);
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
        backgroundImage: 'url(https://bafybeiax2usqi6g7cglrvxa5n3vw7vimqruklebxnmmpm5bo7ah4yldhwi.ipfs.w3s.link/Frame%2039%20(2).png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontFamily: 'Arial, sans-serif',
      }}>
        {profileImage && (
          <img src={profileImage} alt="Profile" style={{ borderRadius: '50%', width: '150px', height: '150px', marginBottom: '20px' }} />
        )}
        <h1 style={{ fontSize: '52px', marginBottom: '20px' }}>{decodeURIComponent(username as string)}'s Stats</h1>
        <div style={{
          display: 'flex',
          flexDirection: 'column' as const,
          alignItems: 'flex-start',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          padding: '20px',
          borderRadius: '10px',
          width: '80%',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>POD Score:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{score}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>Record:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{wins}W - {losses}L - {ties}T</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>Total Games Played:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{games}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '10px' }}>
            <span style={{ fontSize: '36px' }}>/thepod Fan Tokens owned:</span>
            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{Number(tokens).toFixed(2)}</span>
          </div>
        </div>
        <p style={{ fontSize: '28px', marginTop: '20px' }}>Frame by @goldie & @themrsazon</p>
      </div>
    ),
    intents: [
      <Button action="/howtoplay">Play</Button>
    ]
  });
});

app.frame('/shared-game', (c) => {
  const { state } = c.req.query();
  
  let decodedState;
  try {
    decodedState = state ? decodeState(state as string) : {
      board: Array(9).fill(null),
      currentPlayer: 'O',
      isGameOver: false
    };
    console.log('Decoded state:', decodedState);
  } catch (error) {
    console.error('Error decoding state:', error);
    decodedState = {
      board: Array(9).fill(null),
      currentPlayer: 'O',
      isGameOver: false
    };
  }

  // Just return the final game state image
  return c.res({
    image: (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: '1080px',
        height: '1080px',
        backgroundImage: 'url(https://bafybeidmy2f6x42tjkgtrsptnntcjulfehlvt3ddjoyjbieaz7sywohpxy.ipfs.w3s.link/Frame%2039%20(1).png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
        fontFamily: '"Silkscreen", sans-serif',
      }}>
        {renderBoard(decodedState.board)}
        <div style={{
          marginTop: '40px',
          padding: '20px',
          backgroundColor: 'rgba(255, 255, 255, 0.7)',
          borderRadius: '10px',
          color: 'black',
          fontSize: '36px',
          textAlign: 'center',
          maxWidth: '900px',
        }}>
          Can you beat the CPU?
        </div>
      </div>
    ),
    intents: [
      <Button action="/howtoplay">Play</Button>
    ]
  });
});



export const GET = handle(app)
export const POST = handle(app)
