namespace jacdac {
    //% fixedInstances
    export class ControllerService extends Broadcast {
        promptedServers: number[];
        prompting: boolean;

        constructor() {
            super("ctrl", jacdac.CONTROLLER_DEVICE_CLASS, 5);
            this.promptedServers = [];
            this.prompting = false;
            this.controlData[0] = JDControllerCommand.ControlServer;
        }

        private connectClient(address: number, serverAddress: number, receivedPlayerIndex: number): number {
            // fast path: check if player is current
            if (!!serverAddress
                && receivedPlayerIndex > 0
                && receivedPlayerIndex < this.controlData.length
                && address == this.controlData[receivedPlayerIndex]) {
                // player index and server address match
                return receivedPlayerIndex;
            }

            // search existing player index
            for (let i = 1; i < this.controlData.length; ++i)
                if (address == this.controlData[i]) {
                    if (!serverAddress)
                        this.sendPacket(this.controlData);
                    return i;
                }

            this.log(`new player ${toHex8(address)}`);
            const devices = jacdac.devices();
            const players = controller.players();
            const ids: number[] = [0, 0, 0, 0, 0]; // player 0 is not used
            players.forEach(p => ids[p.playerIndex] = 1);

            // did it move?
            // clean dead players
            for (let i = 1; i < this.controlData.length; ++i) {
                const ci = this.controlData[i];
                if (ci && !devices.some(d => d.device_address == ci)) {
                    this.log(`del ${toHex8(this.controlData[i])} from ${i}`);
                    this.controlData[i] = 0;
                    const p = players.find(p => p.playerIndex == i);
                    if (p) p.connected = false;
                }
            }

            // add new player
            // try receivedPlayerIndex first
            if (receivedPlayerIndex
                && this.controlData[receivedPlayerIndex] == 0
                && ids[receivedPlayerIndex]) {
                this.log(`client ${toHex8(address)} -> p${receivedPlayerIndex}`);
                this.controlData[receivedPlayerIndex] = address;
                return receivedPlayerIndex;
            }

            // try other positions 2,3,4 first
            for (let i = 2; i < this.controlData.length; ++i) {
                // if slot is free and there is such a player
                if (this.controlData[i] == 0 && ids[i]) {
                    this.log(`client ${toHex8(address)} -> p${i}`);
                    this.controlData[i] = address;
                    return i;
                }
            }
            // try player 1
            if (this.controlData[1] == 0 && ids[1]) {
                this.log(`client ${toHex8(address)} -> ${1}`);
                this.controlData[1] = address;
                return 1;
            }

            // no slots available
            this.log(`no player for ${toHex8(address)}`);
            return -1;
        }

        handleServiceInformation(device: JDDevice, serviceInfo: JDServiceInformation): number {
            const data = serviceInfo.data;
            return this.processPacket(device.device_address, data);
        }

        handlePacket(packet: JDPacket): number {
            const data = packet.data;
            return this.processPacket(packet.device_address, data);
        }

        private processPacket(address: number, data: Buffer): number {
            const cmd: JDControllerCommand = data[0];
            switch (cmd) {
                case JDControllerCommand.ControlClient:
                    this.connectClient(address, data[1], data[2]);
                    return DAL.DEVICE_OK;
                case JDControllerCommand.ClientButtons:
                    return this.processClientButtons(address, data);
                case JDControllerCommand.ControlServer:
                    return this.processControlServer(address, data);
                default:
                    return DAL.DEVICE_OK;
            }
        }

        private processControlServer(address: number, data: Buffer): number {
            // already prompting for another server
            if (this.prompting) return DAL.DEVICE_OK;
            // so there's another server on the bus,
            // if we haven't done so yet, prompt the user if he wants to join the game
            const device = jacdac.devices().find(d => d.device_address == address);
            if (!device) // can't find any device at that address
                return DAL.DEVICE_OK;

            // check if prompted already
            if (this.promptedServers.indexOf(device.udidl) >= 0)
                return DAL.DEVICE_OK;

            this.prompting = true;
            control.runInParallel(() => {
                const join = this.askJoin(device);
                if (join)
                    joinGame();
                this.prompting = false;
            });

            return DAL.DEVICE_OK;
        }

        private hasPlayers(): boolean {
            for (let i = 1; i < this.controlData.length; ++i)
                if (this.controlData[i]) return true;
            return false;
        }

        private askJoin(device: JDDevice): boolean {
            game.eventContext(); // initialize the game
            control.pushEventContext();
            game.showDialog("Arcade Detected", "Join?", "A = OK, B = CANCEL");
            let answer: boolean = null;
            controller.A.onEvent(ControllerButtonEvent.Pressed, () => answer = true);
            controller.B.onEvent(ControllerButtonEvent.Pressed, () => answer = false);
            pauseUntil(() =>
                // user answered
                answer !== null
                // server got joined
                || this.hasPlayers()
                // other driver dissapeared
                || !jacdac.devices().find(d => d.device_address == device.device_address)
            );
            // wait until we have an answer or the service
            control.popEventContext();

            // cache user answer
            if (answer !== null)
                this.promptedServers.push(device.udidl);

            // check that we haven't been join by then
            return !!answer
                && !this.hasPlayers()
                && !!jacdac.devices().find(d => d.device_address == device.device_address);
        }

        private processClientButtons(address: number, data: Buffer): number {
            const playerIndex = this.connectClient(address, -1, 0);
            if (playerIndex < 0) {
                this.log(`no player for ${toHex8(address)}`);
                return DAL.DEVICE_BUSY;
            }
            const player = controller.players().find(p => p.playerIndex == playerIndex);
            if (!player) {
                this.log(`no player ${player.playerIndex}`);
                return DAL.DEVICE_OK;
            }
            const state = data[1];
            const btns = player.buttons;
            for (let i = 0; i < btns.length; ++i)
                btns[i].setPressed(!!(state & (1 << (i + 1))));
            return DAL.DEVICE_OK;
        }

        sendState() {
            this.sendPacket(this.controlData);
        }
    }

    //% fixedInstance whenUsed block="controller service"
    export const controllerService = new ControllerService();

    function joinGame() {
        // stop server service
        jacdac.controllerService.stop();
        // remove game enterily
        game.popScene();
        // push empty game
        game.pushScene();
        // start client
        console.log(`connecting to server...`);
        jacdac.controllerClient.stateUpdateHandler = function () {
            jacdac.controllerClient.setIsPressed(JDControllerButton.A, controller.A.isPressed());
            jacdac.controllerClient.setIsPressed(JDControllerButton.B, controller.B.isPressed());
            jacdac.controllerClient.setIsPressed(JDControllerButton.Left, controller.left.isPressed());
            jacdac.controllerClient.setIsPressed(JDControllerButton.Up, controller.up.isPressed());
            jacdac.controllerClient.setIsPressed(JDControllerButton.Right, controller.right.isPressed());
            jacdac.controllerClient.setIsPressed(JDControllerButton.Down, controller.down.isPressed());
        }
        game.onPaint(() => {
            if (jacdac.controllerClient.isActive())
                game.showDialog(
                    `connected`,
                    `player ${jacdac.controllerClient.playerIndex}`);
            else
                game.showDialog(
                    `disconnected`,
                    `connect jacdac`);
        });
        jacdac.controllerClient.start();
    }
    // auto start server
    // jacdac.controllerService.start();
    // // TODO: fix control packages in broadcast mode
    // control.runInParallel(function () {
    //     while (jacdac.controllerService.isStarted) {
    //         jacdac.controllerService.sendState();
    //         pause(500);
    //     }
    // })
}