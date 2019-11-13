namespace game {
    let demoMode: boolean;
    /**
     * Indicates if the game was automatically started
     */
    //% blockId=gameisdemomode block="game is demo mode"
    //% group="Demo"
    export function isDemoMode(): boolean {
        return demoMode;
    }

    /**
     * Restarts the device in demo mode
     */
    //% blockId=gameresetindemo block="game reset in demo mode"
    //% group="Demo"
    export function resetInDemoMode() {
        settings.writeNumber("#demo", 1);
        control.reset();
    }

    function initDemoMode() {
        demoMode = !!settings.readNumber("#demo");
        settings.remove("#demo");
    }
    initDemoMode();
}
