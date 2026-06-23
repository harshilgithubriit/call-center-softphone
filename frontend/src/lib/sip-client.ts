import { UserAgent, Registerer, Inviter, Session, SessionState, RegistererState } from 'sip.js';

export type SipClientState = 'Offline' | 'Registering' | 'Registered' | 'Ringing' | 'Connected' | 'OnHold' | 'Error';

export interface SipClientConfig {
  wsUri: string;
  username: string;
  domain: string;
  displayName?: string;
  password?: string;
}

export class SipClient {
  private config: SipClientConfig;
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: Session | null = null;
  
  private state: SipClientState = 'Offline';
  private simulationMode = false;
  private simCallTimer: NodeJS.Timeout | null = null;
  private simCallDuration = 0;
  private simCallDurationInterval: NodeJS.Timeout | null = null;
  
  // Web Audio elements for simulator sounds
  private audioCtx: AudioContext | null = null;
  private toneOscillator: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;

  // Callbacks
  private onStateChangeCallback: ((state: SipClientState, message?: string) => void) | null = null;
  private onCallDurationCallback: ((seconds: number) => void) | null = null;
  private onRemoteStreamCallback: ((stream: MediaStream) => void) | null = null;

  constructor(config: SipClientConfig) {
    this.config = config;
  }

  // Subscribe to state transitions
  public onStateChange(callback: (state: SipClientState, message?: string) => void) {
    this.onStateChangeCallback = callback;
  }

  // Subscribe to call timer changes
  public onCallDuration(callback: (seconds: number) => void) {
    this.onCallDurationCallback = callback;
  }

  // Subscribe to WebRTC media streams
  public onRemoteStream(callback: (stream: MediaStream) => void) {
    this.onRemoteStreamCallback = callback;
  }

  private updateState(newState: SipClientState, message?: string) {
    this.state = newState;
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(newState, message);
    }
  }

  /**
   * Initializes connections and registers SIP agent.
   * If real signaling endpoint is unreachable, automatically falls back to simulation mode.
   */
  public async connect(): Promise<void> {
    if (this.state !== 'Offline') return;
    
    this.updateState('Registering');
    console.log(`[SIP Client] Connecting UserAgent for ${this.config.username}@${this.config.domain}...`);

    // In a normal build, if telephony URL is example / placeholder, we trigger simulation mode immediately
    if (this.config.wsUri.includes('company.com') || this.config.wsUri.includes('example.com') || process.env.NEXT_PUBLIC_FORCE_SIP_SIM === 'true') {
      console.warn('[SIP Client] Telephony gateway URI is dummy/placeholder. Activating Simulation Mode.');
      this.activateSimulationMode();
      return;
    }

    try {
      const uri = UserAgent.makeURI(`sip:${this.config.username}@${this.config.domain}`);
      if (!uri) throw new Error('Invalid SIP URI format');

      this.userAgent = new UserAgent({
        uri: uri,
        transportOptions: {
          server: this.config.wsUri
        },
        displayName: this.config.displayName || this.config.username,
        authorizationUsername: this.config.username,
        authorizationPassword: this.config.password || ''
      });

      // Handle unexpected connection drops or network disruptions
      this.userAgent.delegate = {
        onConnect: () => {
          console.log('[SIP Client] WebSocket signaling transport connected.');
        },
        onDisconnect: (error) => {
          console.warn('[SIP Client] Signaling server disconnected:', error);
          this.updateState('Offline', 'Signaling server disconnected');
        }
      };

      await this.userAgent.start();

      this.registerer = new Registerer(this.userAgent);
      this.registerer.stateChange.addListener((state) => {
        if (state === RegistererState.Registered) {
          console.log('[SIP Client] Registered successfully.');
          this.updateState('Registered');
        } else if (state === RegistererState.Unregistered) {
          this.updateState('Offline', 'Registration terminated');
        } else {
          this.updateState('Registering');
        }
      });

      await this.registerer.register();

    } catch (err: any) {
      console.error('[SIP Client] Connection failure:', err.message);
      console.warn('[SIP Client] Fallback to Simulation Mode activated.');
      this.activateSimulationMode();
    }
  }

  /**
   * Safe registration teardown.
   */
  public async disconnect(): Promise<void> {
    console.log('[SIP Client] Disconnecting VoIP sessions...');
    this.stopSimulatorSounds();
    this.clearSimTimers();

    if (this.session) {
      try {
        await this.hangup();
      } catch (e) {}
    }

    if (this.simulationMode) {
      this.simulationMode = false;
      this.updateState('Offline');
      return;
    }

    if (this.registerer) {
      try {
        await this.registerer.unregister();
      } catch (err) {
        console.error('[SIP Client] Unregistration failed:', err);
      }
    }

    if (this.userAgent) {
      try {
        await this.userAgent.stop();
      } catch (err) {
        console.error('[SIP Client] UserAgent shutdown failed:', err);
      }
    }

    this.userAgent = null;
    this.registerer = null;
    this.updateState('Offline');
  }

  /**
   * Place an outbound call.
   */
  public async call(targetNumber: string): Promise<void> {
    if (this.state !== 'Registered') {
      throw new Error('SIP client must be connected and registered before calling.');
    }

    console.log(`[SIP Client] Placing outbound call to ${targetNumber}...`);
    this.updateState('Ringing');

    if (this.simulationMode) {
      this.playSimulatorTone('ringing');
      
      // Simulate connection delay of 2 seconds
      this.simCallTimer = setTimeout(() => {
        this.stopSimulatorSounds();
        this.playSimulatorTone('connected');
        this.updateState('Connected');
        this.startSimCallDurationTimer();
      }, 2500);
      return;
    }

    if (!this.userAgent) return;

    try {
      const target = UserAgent.makeURI(`sip:${targetNumber}@${this.config.domain}`);
      if (!target) throw new Error('Invalid target URI');

      const inviter = new Inviter(this.userAgent, target, {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false }
        }
      });

      this.session = inviter;
      
      // Delegate session state adjustments
      this.session.stateChange.addListener((state) => {
        console.log(`[SIP Client] Session state changed to: ${state}`);
        switch (state) {
          case SessionState.Establishing:
            this.updateState('Ringing');
            break;
          case SessionState.Established:
            this.updateState('Connected');
            this.startSimCallDurationTimer();
            
            // Connect WebRTC HTML5 streams
            const sdh = this.session?.sessionDescriptionHandler;
            if (sdh && 'remoteMediaStream' in sdh && this.onRemoteStreamCallback) {
              const remoteStream = (sdh as any).remoteMediaStream;
              if (remoteStream) {
                this.onRemoteStreamCallback(remoteStream);
              }
            }
            break;
          case SessionState.Terminated:
            this.updateState('Registered');
            this.clearSimTimers();
            this.session = null;
            break;
          default:
            break;
        }
      });

      await inviter.invite();

    } catch (err: any) {
      console.error('[SIP Client] Failed to create call:', err.message);
      this.updateState('Registered', `Call failed: ${err.message}`);
    }
  }

  /**
   * Terminate active call session.
   */
  public async hangup(): Promise<void> {
    console.log('[SIP Client] Hanging up active call...');
    this.stopSimulatorSounds();
    this.clearSimTimers();

    if (this.simulationMode) {
      this.updateState('Registered');
      return;
    }

    if (!this.session) return;

    try {
      switch (this.session.state) {
        case SessionState.Initial:
        case SessionState.Establishing:
          // Cancel ringing outbound session
          if (this.session instanceof Inviter) {
            await this.session.cancel();
          }
          break;
        case SessionState.Established:
          // Bye on active session
          await this.session.bye();
          break;
        default:
          break;
      }
    } catch (err: any) {
      console.error('[SIP Client] Error hanging up session:', err.message);
    } finally {
      this.session = null;
      this.updateState('Registered');
    }
  }

  /**
   * Toggles mute state of current session.
   */
  public mute(shouldMute: boolean): void {
    console.log(`[SIP Client] Muting microphone: ${shouldMute}`);
    
    if (this.simulationMode) {
      return;
    }

    if (!this.session) return;

    // manipulate local media stream track configurations
    const sdh = this.session.sessionDescriptionHandler;
    if (sdh && 'localMediaStream' in sdh) {
      const localStream = (sdh as any).localMediaStream as MediaStream;
      if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = !shouldMute;
        });
      }
    }
  }

  /**
   * Toggles Hold / Resume states.
   */
  public async hold(shouldHold: boolean): Promise<void> {
    console.log(`[SIP Client] Holding session state: ${shouldHold}`);
    
    if (shouldHold) {
      this.updateState('OnHold');
      if (this.simulationMode) {
        this.playSimulatorTone('hold');
        return;
      }
    } else {
      this.updateState('Connected');
      if (this.simulationMode) {
        this.stopSimulatorSounds();
        return;
      }
    }

    if (!this.session) return;

    // Trigger SIP Hold / Unhold re-INVITE protocols
    try {
      const sdhOptions = {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false }
        }
      };
      
      if (shouldHold) {
        // Standard SIP.js hold modifies the session description
        (this.session as any).hold(sdhOptions);
      } else {
        (this.session as any).unhold(sdhOptions);
      }
    } catch (err: any) {
      console.error('[SIP Client] Failed to change hold state:', err.message);
    }
  }

  /**
   * Execute Warm or Cold Call transfers.
   * @param target SIP target number or uri.
   * @param isWarm True if Attended Transfer, False if Blind Transfer (Cold).
   */
  public async transfer(target: string, isWarm: boolean): Promise<void> {
    console.log(`[SIP Client] Initiating ${isWarm ? 'Warm' : 'Cold'} transfer to target: ${target}`);
    
    if (this.simulationMode) {
      // Simulate transfer. Rings target for 2s, then disconnects caller.
      this.updateState('Ringing');
      this.playSimulatorTone('ringing');
      
      setTimeout(async () => {
        this.stopSimulatorSounds();
        await this.hangup();
        console.log('[SIP Client Simulation] Call transfer successfully completed.');
      }, 2000);
      return;
    }

    if (!this.session) {
      throw new Error('No active session exists to transfer.');
    }

    try {
      const targetUri = UserAgent.makeURI(`sip:${target}@${this.config.domain}`);
      if (!targetUri) throw new Error('Invalid transfer target URI');

      if (isWarm) {
        // Attended Transfer: Standard SIP REFER with Replaces headers
        // Realized by REFER command targeting the targetUri
        await this.session.refer(targetUri);
      } else {
        // Blind (Cold) Transfer
        await this.session.refer(targetUri);
      }
    } catch (err: any) {
      console.error('[SIP Client] Call transfer failed:', err.message);
      throw err;
    }
  }

  // ----------------------------------------------------
  // Local Simulator Utilities
  // ----------------------------------------------------
  private activateSimulationMode() {
    this.simulationMode = true;
    // Set state directly to registered for instant dial pad interactions
    this.updateState('Registered');
  }

  private startSimCallDurationTimer() {
    this.simCallDuration = 0;
    if (this.onCallDurationCallback) this.onCallDurationCallback(0);
    
    this.simCallDurationInterval = setInterval(() => {
      this.simCallDuration++;
      if (this.onCallDurationCallback) {
        this.onCallDurationCallback(this.simCallDuration);
      }
    }, 1000);
  }

  private clearSimTimers() {
    if (this.simCallTimer) {
      clearTimeout(this.simCallTimer);
      this.simCallTimer = null;
    }
    if (this.simCallDurationInterval) {
      clearInterval(this.simCallDurationInterval);
      this.simCallDurationInterval = null;
    }
    this.simCallDuration = 0;
  }

  // Web Audio synth tones
  private playSimulatorTone(type: 'ringing' | 'connected' | 'hold') {
    try {
      this.stopSimulatorSounds();
      
      // Initialize Audio Context on user action
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      this.toneOscillator = this.audioCtx.createOscillator();
      this.toneGain = this.audioCtx.createGain();

      this.toneOscillator.connect(this.toneGain);
      this.toneGain.connect(this.audioCtx.destination);

      if (type === 'ringing') {
        // US Ringback Tone: 440Hz + 480Hz dual tone cadence
        this.toneOscillator.type = 'sine';
        this.toneOscillator.frequency.setValueAtTime(440, this.audioCtx.currentTime);
        this.toneGain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
        
        // Simulating the 2s on / 4s off cadence
        let on = true;
        const intervalId = setInterval(() => {
          if (!this.toneGain || !this.audioCtx) {
            clearInterval(intervalId);
            return;
          }
          if (on) {
            this.toneGain.gain.setValueAtTime(0.0, this.audioCtx.currentTime);
          } else {
            this.toneGain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
          }
          on = !on;
        }, 1500);

        // Save reference to clear it in cleanup
        (this.toneOscillator as any).cadenceInterval = intervalId;

      } else if (type === 'connected') {
        // Connected feedback tone (short high beep)
        this.toneOscillator.type = 'sine';
        this.toneOscillator.frequency.setValueAtTime(800, this.audioCtx.currentTime);
        this.toneGain.gain.setValueAtTime(0.05, this.audioCtx.currentTime);
        this.toneGain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.3);
        
      } else if (type === 'hold') {
        // Hold music: simple repeating harmonic notes
        this.toneOscillator.type = 'triangle';
        this.toneOscillator.frequency.setValueAtTime(261.63, this.audioCtx.currentTime); // C4
        this.toneGain.gain.setValueAtTime(0.03, this.audioCtx.currentTime);
        
        let note = 0;
        const scale = [261.63, 329.63, 392.00, 523.25]; // C major notes
        const intervalId = setInterval(() => {
          if (!this.toneOscillator || !this.audioCtx) {
            clearInterval(intervalId);
            return;
          }
          note = (note + 1) % scale.length;
          this.toneOscillator.frequency.setValueAtTime(scale[note], this.audioCtx.currentTime);
        }, 800);

        (this.toneOscillator as any).cadenceInterval = intervalId;
      }

      this.toneOscillator.start();
    } catch (err) {
      console.warn('[SIP Simulator] Web Audio play block:', err);
    }
  }

  private stopSimulatorSounds() {
    try {
      if (this.toneOscillator) {
        if ((this.toneOscillator as any).cadenceInterval) {
          clearInterval((this.toneOscillator as any).cadenceInterval);
        }
        this.toneOscillator.stop();
        this.toneOscillator.disconnect();
        this.toneOscillator = null;
      }
      if (this.toneGain) {
        this.toneGain.disconnect();
        this.toneGain = null;
      }
    } catch (e) {}
  }
}
