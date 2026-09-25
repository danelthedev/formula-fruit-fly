I want to create a web app project as follows:
 * The user should be able to draw a track on a canvas (by click and holding). The
   track shouldn't have any overlaps and should be a closed shape (like a racing
   circuit). There should be an undo functionality as well. The user will decide where
   the start/finish line is
 * Once the circuit is done, "checkpoints" should be automatically placed throughout
   the circuit.
 * The user should be able to configure "teams". Teams consist of a name, a color
   scheme (primary and secondary color of the car) and some specs for their car
   (performance stats, like top speed, acceleration, break efficiency, turning
   ability).
 * The user will have a "start training" button available which will start training a
   neural network. The neural network will simulate a car driving the circuit. It's
   outputs should be accelerate (float 0-1), brake (float 0-1), steer (float -1,1).
   Not sure what it's inputs should be, you can help me figure this out. The
   simulation will apply for each team so each team is trained based on the specs of
   its own car. Going outside of the drawn circuit is considered crashing and the car
   fails.
 * After enough epochs the user can stop the training and the profile of the AI will
   be used in the next phase
 * The user will be able to select how many drivers are per team (all teams have the
   same number of drivers)
 * Once training is over there will be 2 stages:
 * First stage is qualifying. Each racer will do 1 lap on the circuit and based on the
   lap time they will be placed on the racing grid. The grid will be generated behind
   the start/finish line and spaced out like in a formula 1 race.                       * Second stage is the actual racing. The user can configure how many laps the race
   takes. For now the cars should have no collision between one another so they can
   pass through without issues. Any car that leaves the drawn circuit is considered as    crashed and removed from the race.
 * The user should be able to save configured teams, tracks and NN weights and load
   them in future sessions. These things should also be stored on the browser storage
   so they are retained between sessions.
 * The training should be done on the user's hardware, not the server. Preferably gpu     accelerated if possible/helpful